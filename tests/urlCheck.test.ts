import { afterEach, describe, expect, it, vi } from 'vitest';
import { urlProblem } from '../src/web/urlCheck.ts';

const { parseInstanceUrl } = await import('../src/server/instanceUrl.ts');
afterEach(() => vi.unstubAllEnvs());

// Settings warns while you type; the server is still the one that decides. The two must agree.
describe('instance address check in Settings', () => {
  it.each([
    'dev12345.service-now.com', 'https://dev12345.service-now.com', 'HTTPS://acme.service-now.com/now/nav/ui',
    'http://dev12345.service-now.com', 'ftp://dev12345.service-now.com', 'HTTP://acme.service-now.com', 'javascript://x',
  ])('agrees with the server on %s', (raw) => {
    expect(!!urlProblem(raw)).toBe('error' in parseInstanceUrl(raw));
  });

  it('leaves plain http on this machine to the server (allowed only for a local test instance)', () => {
    vi.stubEnv('WAYFINDER_ALLOW_HTTP_LOOPBACK', '1');
    expect(urlProblem('http://127.0.0.1:8080')).toBe('');
    expect(parseInstanceUrl('http://127.0.0.1:8080')).toHaveProperty('url');
  });

  it('says nothing while the box is empty', () => expect(urlProblem('  ')).toBe(''));
});
