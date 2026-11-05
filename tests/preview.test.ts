import { describe, expect, it } from 'vitest';
import { PREVIEW_CSP, VIEWPORTS, fitScale, withPreviewPolicy } from '../src/web/preview.ts';

const meta = (html: string) => html.indexOf('http-equiv="Content-Security-Policy"');

describe('withPreviewPolicy', () => {
  it('puts the policy first in <head>', () => {
    const out = withPreviewPolicy('<!doctype html><html><head><title>x</title><link rel="stylesheet" href="https://e.com/a.css"></head><body></body></html>');
    expect(meta(out)).toBeGreaterThan(out.indexOf('<head>'));
    expect(meta(out)).toBeLessThan(out.indexOf('<title>'));
  });
  it('keeps the doctype first, so the page stays in standards mode', () => {
    expect(withPreviewPolicy('<!DOCTYPE html><body>hi</body>')).toMatch(/^<!DOCTYPE html><head><meta http-equiv="Content-Security-Policy"/);
  });
  it('handles a bare fragment and a <head> with attributes', () => {
    expect(withPreviewPolicy('<div>hi</div>').startsWith('<head><meta')).toBe(true);
    const out = withPreviewPolicy('<html><head lang="en"><style>a{}</style></head></html>');
    expect(meta(out)).toBeLessThan(out.indexOf('<style>'));
  });
  it('allows nothing from the network', () => {
    expect(PREVIEW_CSP).toContain("default-src 'none'");
    expect(PREVIEW_CSP).toContain("connect-src 'none'");
    expect(PREVIEW_CSP).toContain("form-action 'none'");
    expect(PREVIEW_CSP).not.toMatch(/https?:|\*/);
  });
});

describe('fitScale', () => {
  const desktop = VIEWPORTS.desktop;
  it('shrinks a desktop mockup into a narrow panel without changing its size', () => {
    expect(fitScale(desktop, { w: 436, h: 800 }, 'fit')).toBeCloseTo(436 / 1440);
  });
  it('fits the tighter side, and never enlarges', () => {
    expect(fitScale(desktop, { w: 2000, h: 450 }, 'fit')).toBeCloseTo(0.5);
    expect(fitScale(VIEWPORTS.phone, { w: 2000, h: 2000 }, 'fit')).toBe(1);
  });
  it("'width' ignores the height", () => {
    expect(fitScale(desktop, { w: 720, h: 100 }, 'width')).toBeCloseTo(0.5);
  });
});
