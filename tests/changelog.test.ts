import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';

const changelog = JSON.parse(readFileSync(new URL('../changelog.json', import.meta.url), 'utf8')) as { version: string; date: string; title: string; items: string[] }[];
const pkg = JSON.parse(readFileSync(new URL('../package.json', import.meta.url), 'utf8')) as { version: string };
const parts = (v: string) => v.split('.').map(Number);
const newer = (a: string, b: string) => { const [x, y] = [parts(a), parts(b)]; for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] > y[i]; return false; };

describe('changelog.json', () => {
  it('has a newest entry that matches package.json', () => {
    expect(changelog[0].version).toBe(pkg.version);
  });

  it('lists every release once, newest first', () => {
    for (let i = 1; i < changelog.length; i++) {
      expect(newer(changelog[i - 1].version, changelog[i].version), `${changelog[i - 1].version} before ${changelog[i].version}`).toBe(true);
      expect(changelog[i - 1].date >= changelog[i].date).toBe(true);
    }
  });

  it('gives each entry a version, date, title and plain-words items', () => {
    for (const e of changelog) {
      expect(e.version).toMatch(/^\d+\.\d+\.\d+$/);
      expect(e.date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(e.title.trim()).not.toBe('');
      expect(e.items.length).toBeGreaterThan(0);
      for (const item of e.items) expect(typeof item === 'string' && item.trim().length > 0).toBe(true);
    }
  });
});
