import type { HonoRequest, MiddlewareHandler } from 'hono';

const isHttps = (req: HonoRequest) => req.header('x-forwarded-proto') === 'https' || req.url.startsWith('https:');

export function secureCookie(req: HonoRequest): boolean {
  const host = req.header('host') ?? new URL(req.url).host;
  return isHttps(req) || !/^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/i.test(host);
}

export const securityHeaders: MiddlewareHandler = async (c, next) => {
  await next();
  c.header('X-Content-Type-Options', 'nosniff');
  c.header('Referrer-Policy', 'no-referrer');
  if (isHttps(c.req)) c.header('Strict-Transport-Security', 'max-age=31536000');
};
