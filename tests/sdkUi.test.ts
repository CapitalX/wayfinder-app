import { createElement, type ComponentProps } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import { SdkControls } from '../src/web/components/SdkUpdate.tsx';

const state = {
  version: '4.14.0', source: 'bundled', admin: true, previous: '4.13.0', checkedAt: null,
  offer: { version: '4.15.0', bytes: 10 * 1024 ** 2 }, health: { verified: 'yes', errors: [] }, job: null,
};
const render = (patch: Partial<NonNullable<ComponentProps<typeof SdkControls>['state']>> = {}) =>
  renderToStaticMarkup(createElement(SdkControls, { state: { ...state, ...patch }, busy: false, error: '', act: vi.fn() }));
describe('SDK controls (static rendering, no browser)', () => {
  it('shows the version and health to non-admins without action buttons', () => {
    const html = render({ admin: false });
    expect(html).toContain('4.14.0'); expect(html).toContain('every example builds');
    expect(html).not.toContain('<button'); expect(html).not.toContain('Update to');
  });
  it('explains the download and check, with check and rollback actions', () => {
    const html = render();
    for (const text of ['about 10 MB', 'dependencies', 'switches if it passes', 'Update to 4.15.0', 'Check now', 'Go back to 4.13.0']) expect(html).toContain(text);
  });
  it('makes Keep current the primary decision and lists failing examples', () => {
    const html = render({ job: { version: '4.15.0', state: 'needs decision', step: "Didn't pass", errors: ['tables.now.ts: Unknown column'] } });
    expect(html).toContain('tables.now.ts: Unknown column');
    expect(html).toContain('class="primary">Keep current</button>');
    expect(html.indexOf('>Keep current<')).toBeLessThan(html.indexOf('>Use anyway<'));
    expect(html).toContain('is still in use'); expect(html).not.toContain('Update to');
  });
  it('announces progress and prevents a second install while running', () => {
    const html = render({ job: { version: '4.15.0', state: 'running', step: 'Checking the cheat sheet', errors: [] } });
    expect(html).toContain('aria-live="polite"'); expect(html).toContain('Checking the cheat sheet');
    expect(html).toContain('disabled=""');
  });
});
