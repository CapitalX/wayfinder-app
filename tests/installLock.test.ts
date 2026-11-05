import { describe, expect, it } from 'vitest';

const { claimApp } = await import('../src/server/buildTools.ts');

const app = (status = 'built', id = 'a1') => ({ id, name: 'Loans', status }) as any;

describe('one install or removal per app', () => {
  it('lets only the first of two calls that arrive together start', async () => {
    const results = await Promise.allSettled([0, 1].map(async () => { const release = claimApp(app()); await new Promise((r) => setTimeout(r, 20)); release(); }));
    expect(results.map((r) => r.status)).toEqual(['fulfilled', 'rejected']);
    expect(String((results[1] as PromiseRejectedResult).reason)).toMatch(/already being installed/);
  });
  it('frees the app once the run ends, and releasing twice is harmless', () => {
    const release = claimApp(app('built', 'a2'));
    release(); release();
    expect(() => claimApp(app('built', 'a2'))()).not.toThrow();
  });
  it('refuses while the saved status says an install or removal is running', () => {
    expect(() => claimApp(app('installing', 'a3'))).toThrow(/being installed/);
    expect(() => claimApp(app('removing', 'a4'))).toThrow(/being removed/);
  });
});
