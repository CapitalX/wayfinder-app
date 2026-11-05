import { readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { parseScreen, renderScreen } from '../src/web/screen.ts';

const fixture = readFileSync(new URL('./fixtures/screen-loaners.json', import.meta.url), 'utf8');
const base = () => JSON.parse(fixture);
const problems = (spec: unknown) => { const r = parseScreen(JSON.stringify(spec)); return 'problems' in r ? r.problems : []; };

describe('screen specs', () => {
  it('accept the list/detail workspace fixture', () => {
    expect(parseScreen(fixture)).toHaveProperty('spec');
  });
  it('reject what the kit does not support, naming the place', () => {
    const s = base(); s.record.tabs[0].charts = [{}];
    expect(problems(s).join('\n')).toMatch(/record\.tabs\.0: not supported by this kit \(charts\)/);
    const t = base(); t.surface = 'portal';
    expect(problems(t).join('\n')).toMatch(/^surface:/m);
    expect(problems({ kit: 'something-else' }).join('\n')).toMatch(/^kit:/m);
  });
  it('need unique ids, a real active tab and rows that match the columns', () => {
    const s = base(); s.record.tabs[0].sections[0].fields[1].id = 'f_borrower'; s.record.active_tab = 't_nope'; s.list.rows[0].secret = 'x';
    const p = problems(s).join('\n');
    expect(p).toMatch(/ids must be unique \(repeated: f_borrower\)/);
    expect(p).toMatch(/record\.active_tab: no tab "t_nope"/);
    expect(p).toMatch(/list\.rows\.0: "secret" isn't one of the columns/);
  });
  it('say when it is not JSON at all', () => {
    expect(parseScreen('{ nope')).toEqual({ problems: [expect.stringMatching(/^Not valid JSON/)] });
  });
});

describe('the screen kit renderer', () => {
  const spec = () => (parseScreen(fixture) as { spec: any }).spec;
  it('draws one self-contained page with stable ids on every part', () => {
    const html = renderScreen(spec());
    expect(html.startsWith('<!doctype html><html lang="en">')).toBe(true);
    expect(html).not.toMatch(/<script|<link|https?:\/\/(?!www\.w3)/);
    for (const id of ['nav', 'list', 'rec', 'n_due', 'a_return', 't_details', 's_loan', 'f_borrower']) expect(html).toContain(`data-id="${id}"`);
  });
  it('labels it as a mockup, with what is simulated and assumed', () => {
    const html = renderScreen(spec());
    expect(html).toContain('Not a UI Builder page');
    expect(html).toContain('Simulated: Check out and Return only look like they work');
    expect(html).toContain('Assumed: Agents work from the IT service desk');
  });
  it('escapes every value, so spec text can never become markup', () => {
    const s = spec(); s.title = '<img src=x onerror=alert(1)>'; s.record.tabs[0].sections[0].fields[0].value = '"><script>x</script>';
    const html = renderScreen(s);
    expect(html).not.toContain('<img src=x');
    expect(html).not.toContain('<script>x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });
  it('draws loading, empty and error states', () => {
    const s = spec();
    s.list.state = 'loading'; expect(renderScreen(s)).toContain('Loading…');
    s.list.state = 'empty'; s.list.empty_text = 'Nothing due today.'; expect(renderScreen(s)).toContain('Nothing due today.');
    s.record.state = 'error'; s.record.error_text = 'Could not load the loan.'; expect(renderScreen(s)).toContain('Could not load the loan.');
  });
  it('carries the spec inside, so a saved screen can be revised', () => {
    expect(renderScreen(spec())).toMatch(/<!-- wayfinder-screen: \{/);
  });
});
