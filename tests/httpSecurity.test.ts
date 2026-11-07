import { Hono } from 'hono';
import { HonoRequest } from 'hono/request';
import { describe, expect, it } from 'vitest';
import { secureCookie, securityHeaders } from '../src/server/httpSecurity.ts';

describe('session cookie transport', () => {
  it.each(['localhost', '127.0.0.1', '[::1]', 'localhost:8797', '127.0.0.1:8797', '[::1]:8797', 'LOCALHOST:8797'])('allows HTTP only on %s', (host) => {
    const req = new HonoRequest(new Request(`http://${host}/`));
    expect(secureCookie(req)).toBe(false);
  });

  it.each(['example.com', 'example.com:8797', '203.0.113.10:8797', '[2001:db8::1]:8797', 'localhost.example.com', '127.0.0.1.example.com'])('requires a Secure cookie on HTTP for %s', (host) => {
    const req = new HonoRequest(new Request(`http://${host}/`));
    expect(secureCookie(req)).toBe(true);
  });

  it('uses the Host header when present', () => {
    const req = new HonoRequest(new Request('http://localhost/', { headers: { host: 'example.com:8797' } }));
    expect(secureCookie(req)).toBe(true);
  });

  it.each([
    ['https://localhost/', {}],
    ['http://localhost/', { 'x-forwarded-proto': 'https' }],
    ['https://localhost/', { 'x-forwarded-proto': 'http' }],
  ])('requires a Secure cookie for HTTPS: %s %j', (url, headers) => {
    expect(secureCookie(new HonoRequest(new Request(url, { headers })))).toBe(true);
  });
});

describe('response security headers', () => {
  const app = new Hono();
  app.use('*', securityHeaders);
  app.get('/api/session', (c) => c.json({ ok: true }));
  app.get('/api/refused', (c) => c.json({ error: 'login required' }, 401));
  app.get('/assets/app.js', () => new Response('export {};'));
  app.get('/', (c) => c.html('<!doctype html><title>Wayfinder</title>'));

  it.each(['/api/session', '/api/refused', '/assets/app.js', '/', '/missing'])('sets headers on %s, including early responses and missing routes', async (path) => {
    const res = await app.request(`http://example.com${path}`);
    expect(res.headers.get('X-Content-Type-Options')).toBe('nosniff');
    expect(res.headers.get('Referrer-Policy')).toBe('no-referrer');
    expect(res.headers.has('Strict-Transport-Security')).toBe(false);
  });

  it.each([
    ['https://localhost/', {}, true],
    ['http://localhost/', { 'x-forwarded-proto': 'https' }, true],
    ['https://example.com/', { 'x-forwarded-proto': 'http' }, true],
    ['http://example.com/', {}, false],
    ['http://localhost/', {}, false],
    ['http://example.com/', { 'x-forwarded-proto': 'http' }, false],
  ])('sets HSTS only for HTTPS: %s %j', async (url, headers, https) => {
    const res = await app.request(url, { headers });
    expect(res.headers.get('Strict-Transport-Security')).toBe(https ? 'max-age=31536000' : null);
  });
});
