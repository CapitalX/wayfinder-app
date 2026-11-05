import { describe, expect, it } from 'vitest';

const { holdApp } = await import('../src/server/buildTools.ts');

const app = (id: string) => ({ id, name: 'Loans' });

describe('one writer per app', () => {
  it('refuses a second chat while one chat writes, and lets it in after', () => {
    const release = holdApp(app('w1'), 'chatA', 'building');
    expect(() => holdApp(app('w1'), 'chatB', 'writing files')).toThrow(/Loans is busy in another chat \(building\)/);
    release();
    expect(() => holdApp(app('w1'), 'chatB', 'writing files')()).not.toThrow();
  });
  it('lets the same chat nest (a write that builds) and only the outer hold releases', () => {
    const outer = holdApp(app('w2'), 'chatA', 'writing files and building');
    const inner = holdApp(app('w2'), 'chatA', 'building');
    inner();
    expect(() => holdApp(app('w2'), 'chatB', 'building')).toThrow(/busy in another chat/);
    outer();
    expect(() => holdApp(app('w2'), 'chatB', 'building')()).not.toThrow();
  });
  it('keeps different apps independent', () => {
    const a = holdApp(app('w3'), 'chatA', 'building');
    expect(() => holdApp(app('w4'), 'chatB', 'building')()).not.toThrow();
    a();
  });
  it('a background install blocks its own chat too, until it ends', () => {
    const release = holdApp(app('w5'), 'chatA', 'installing', true);
    expect(() => holdApp(app('w5'), 'chatA', 'writing files')).toThrow(/Loans is busy \(installing\)/);
    release(); release();
    expect(() => holdApp(app('w5'), 'chatA', 'writing files')()).not.toThrow();
  });
});
