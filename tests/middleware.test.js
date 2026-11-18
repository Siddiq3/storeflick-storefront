import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { NextRequest } from 'next/server';
import { middleware } from '../middleware.js';
import { clearResolverCache } from '@/lib/resolver.js';
import { fail, mockApi, ok } from './helpers.js';

const request = (host, path = '/', headers = {}) => new NextRequest(`https://${host}${path}`, { headers: { host, ...headers } });
const forwarded = (response, name) => response.headers.get(`x-middleware-request-${name}`);
const rewritten = (response) => response.headers.get('x-middleware-rewrite');

const STORES = {
  'asha.storeflick.in': { slug: 'asha', canonicalHost: 'asha.storeflick.in', redirect: false },
  'demo.storeflick.in': { slug: 'demo', canonicalHost: 'demo.storeflick.in', redirect: false },
  'old.storeflick.in': { slug: 'asha', canonicalHost: 'shop.example.com', redirect: true },
};

describe('middleware: hostname -> store', () => {
  let calls;
  beforeEach(() => {
    clearResolverCache();
    calls = mockApi({ 'GET /public/hosts/resolve': ({ url }) => {
      const host = url.searchParams.get('host');
      return host in STORES ? ok(STORES[host]) : fail(404, 'STORE_NOT_FOUND');
    } });
  });

  it('passes the resolved slug to the page in a header', async () => {
    const response = await middleware(request('asha.storeflick.in', '/products'));
    expect(forwarded(response, 'x-storeflick-slug')).toBe('asha');
    expect(forwarded(response, 'x-storeflick-canonical-host')).toBe('asha.storeflick.in');
    expect(response.status).toBe(200);
  });

  it('cannot be told which store to use: a client-supplied slug header is discarded', async () => {
    const response = await middleware(request('asha.storeflick.in', '/', { 'x-storeflick-slug': 'demo', 'x-storeflick-canonical-host': 'demo.storeflick.in' }));
    expect(forwarded(response, 'x-storeflick-slug')).toBe('asha');
    expect(forwarded(response, 'x-storeflick-canonical-host')).toBe('asha.storeflick.in');
  });

  it('a businessId in the URL, query or headers changes nothing', async () => {
    const response = await middleware(request('asha.storeflick.in', '/?businessId=01HZZZ&slug=demo', { 'x-business-id': '01HZZZ' }));
    expect(forwarded(response, 'x-storeflick-slug')).toBe('asha');
    expect(calls).toHaveLength(1);
    expect(calls[0].url.searchParams.get('host')).toBe('asha.storeflick.in');
  });

  it('an unknown store is a 404 state page', async () => {
    const response = await middleware(request('nobody.storeflick.in'));
    expect(response.status).toBe(404);
    expect(rewritten(response)).toContain('/store-not-found');
    expect(forwarded(response, 'x-storeflick-slug')).toBeNull();
  });

  it('an invalid host is a 400 state page, without asking the API', async () => {
    const response = await middleware(request('asha.storeflick.in', '/', { host: 'not a host' }));
    expect(response.status).toBe(400);
    expect(rewritten(response)).toContain('/invalid-host');
    expect(calls).toHaveLength(0);
  });

  it('an unreachable API is a 503 that says to retry, and a message with no detail', async () => {
    clearResolverCache();
    mockApi({ 'GET /public/hosts/resolve': fail(500, 'INTERNAL_ERROR', 'stack trace: secret detail') });
    const response = await middleware(request('asha.storeflick.in'));
    expect(response.status).toBe(503);
    expect(response.headers.get('retry-after')).toBe('10');
    expect(rewritten(response)).toContain('/store-unavailable');
  });

  it('a non-canonical address is redirected to the canonical one, keeping path and query', async () => {
    const response = await middleware(request('old.storeflick.in', '/products/x--1?sort=price_asc'));
    expect(response.status).toBe(308);
    expect(response.headers.get('location')).toBe('https://shop.example.com/products/x--1?sort=price_asc');
  });

  it('the state pages cannot be requested directly', async () => {
    for (const path of ['/store-not-found', '/invalid-host', '/store-unavailable']) {
      const response = await middleware(request('asha.storeflick.in', path));
      expect(response.status, path).toBe(404);
    }
  });

  it('gives two stores their own slug even on the same server, request after request', async () => {
    const a = await middleware(request('asha.storeflick.in'));
    const b = await middleware(request('demo.storeflick.in'));
    expect([forwarded(a, 'x-storeflick-slug'), forwarded(b, 'x-storeflick-slug')]).toEqual(['asha', 'demo']);
  });

  it('forwards the shopper address (from the configured header) when resolving', async () => {
    await middleware(request('asha.storeflick.in', '/', { 'cf-connecting-ip': '203.0.113.9' }));
    expect(calls[0].headers['cf-connecting-ip']).toBe('203.0.113.9');
  });

  it('does not forward a shopper address that is not exactly one address', async () => {
    await middleware(request('asha.storeflick.in', '/', { 'cf-connecting-ip': '203.0.113.9, 10.0.0.1' }));
    expect(calls[0].headers['cf-connecting-ip']).toBeUndefined();
  });

  it('is a 503, not a crash, when the server is misconfigured', async () => {
    const saved = process.env.EDGE_SHARED_SECRET;
    process.env.EDGE_SHARED_SECRET = 'short';
    try {
      const response = await middleware(request('asha.storeflick.in'));
      expect(response.status).toBe(503);
    } finally {
      process.env.EDGE_SHARED_SECRET = saved;
    }
  });
});

describe('middleware: preview deployment (PREVIEW_STORE_SLUG)', () => {
  let calls;
  beforeEach(() => {
    clearResolverCache();
    process.env.PREVIEW_STORE_SLUG = 'asha';
    calls = mockApi({ 'GET /public/hosts/resolve': ({ url }) => {
      const host = url.searchParams.get('host');
      return host in STORES ? ok(STORES[host]) : fail(404, 'STORE_NOT_FOUND');
    } });
  });
  afterEach(() => { delete process.env.PREVIEW_STORE_SLUG; });

  it('serves its one store on a workers.dev address, asking the API about <slug>.<root>', async () => {
    const response = await middleware(request('storeflick-preview.example.workers.dev', '/products'));
    expect(calls[0].url.searchParams.get('host')).toBe('asha.storeflick.in');
    expect(forwarded(response, 'x-storeflick-slug')).toBe('asha');
    expect(forwarded(response, 'x-storeflick-host')).toBe('storeflick-preview.example.workers.dev');
    expect(response.headers.get('x-robots-tag')).toBe('noindex, nofollow');
  });

  it('still cannot be told which store to use by the client', async () => {
    const response = await middleware(request('storeflick-preview.example.workers.dev', '/', { 'x-storeflick-slug': 'demo' }));
    expect(forwarded(response, 'x-storeflick-slug')).toBe('asha');
  });

  it('a slug the API does not know is the ordinary 404 state page', async () => {
    process.env.PREVIEW_STORE_SLUG = 'nobody';
    const response = await middleware(request('storeflick-preview.example.workers.dev'));
    expect(response.status).toBe(404);
    expect(rewritten(response)).toContain('/store-not-found');
  });

  it('a malformed slug is a configuration error, not a store', async () => {
    process.env.PREVIEW_STORE_SLUG = 'Not A Slug!';
    const response = await middleware(request('storeflick-preview.example.workers.dev'));
    expect(response.status).toBe(503);
    expect(calls).toHaveLength(0);
  });

  it('without it, production behaviour is unchanged: no robots header, the Host is what is resolved', async () => {
    delete process.env.PREVIEW_STORE_SLUG;
    const response = await middleware(request('asha.storeflick.in'));
    expect(calls[0].url.searchParams.get('host')).toBe('asha.storeflick.in');
    expect(response.headers.get('x-robots-tag')).toBeNull();
  });
});
