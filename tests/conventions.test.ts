import { describe, expect, it, vi } from 'vitest';

// The tidy-up call is mocked: one rule with a real example, one whose example isn't in the samples (dropped), and an
// instruction-like rule is just text (it only ever becomes a line of guidance the user approves).
vi.mock('@anthropic-ai/claude-agent-sdk', () => ({
  query: () => (async function* () {
    yield { type: 'result', subtype: 'success', result: JSON.stringify([
      { area: 'Update sets', rule: 'Start update set names with the story number, then " - " and a description.', example: 'STRY0010231 - Loaner reminders' },
      { area: 'Other', rule: 'Made-up rule', example: 'not in the samples' },
    ]) };
  })(),
}));

const { detect, draftRules, conventionsPrompt } = await import('../src/server/conventions.ts');
// This file mocks the SDK's query itself, so small jobs use the real runner (which then calls the mock).
(await import('../src/server/smallJob.ts')).setSmallJobRunner();
const { conventions } = await import('../src/server/db.ts');

const SAMPLES = {
  updateSets: ['STRY0010231 - Loaner reminders', 'STRY0010198 - Asset intake form', 'CHG0030012 - Patch catalog variables', 'STRY0010150 - Fix SLA timer', 'Default'],
  scopes: ['x_acme_loan', 'x_acme_intake', 'x_acme_slafix'],
  scriptIncludes: ['LoanerUtils', 'AssetIntakeUtils', 'SlaHelper', 'CatalogUtils'],
  businessRules: ['Loaner - Set due date', 'Loaner - Notify overdue', 'Asset - Default owner', 'set priority'],
  clientScripts: ['onLoad stuff'],
  uiPolicies: [],
  tables: ['x_acme_loan_request', 'x_acme_intake_item', 'x_acme_loan_asset'],
  fields: ['u_due_date', 'u_loaner', 'u_cost_center', 'x_acme_loan_flag'],
  properties: ['x_acme_loan.reminder.days', 'x_acme_loan.reminder.enabled', 'x_acme_intake.default.group'],
};

describe('convention detection', () => {
  const found = detect(SAMPLES);
  const by = (id: string) => found.find((f) => f.id === id);

  it('reads the update set naming shape', () => {
    const f = by('update-set-ticket')!;
    expect(f.rule).toMatch(/ticket number \(STRY, CHG\)/);
    expect(f.rule).toContain('" - "');
    expect(f.example).toBe('STRY0010231 - Loaner reminders');
    expect(f.support).toBe('4 of 4 update sets');
  });
  it('finds the vendor prefix and short app codes', () => {
    expect(by('scope-prefix')!.rule).toContain('x_acme_');
    expect(by('scope-prefix')!.rule).toContain('short lowercase app code');
  });
  it('names script includes and business rules the way the team does', () => {
    expect(by('script-include-case')!.rule).toContain('PascalCase');
    expect(by('script-include-case')!.rule).toContain('"Utils"');
    expect(by('br-prefix')!.rule).toContain('"<Prefix> - <what it does>"');
    expect(by('cs-prefix')).toBeUndefined(); // one sample proves nothing
  });
  it('tells global u_ fields from scoped tables, and dotted properties', () => {
    expect(by('field-prefix')!.rule).toContain('u_<snake_case>');
    expect(by('table-prefix')!.rule).toContain('scoped apps');
    expect(by('property-names')!.rule).toContain('<scope>.<area>.<setting>');
  });
  it('finds nothing in an empty instance', () => {
    expect(detect({ updateSets: [], scopes: [], scriptIncludes: [], businessRules: [], clientScripts: [], uiPolicies: [], tables: [], fields: [], properties: [] })).toEqual([]);
  });
});

describe('rules', () => {
  it('keeps only drafted rules whose example is a real sample', async () => {
    const rules = await draftRules(detect(SAMPLES), SAMPLES);
    expect(rules).toHaveLength(1);
    expect(rules[0].example).toBe('STRY0010231 - Loaner reminders');
  });
  it('only approved rules reach the prompt, and turning it off removes them', () => {
    const inst = { id: 'inst-1' } as never;
    conventions.propose('inst-1', [{ id: 'r1', area: 'Update sets', rule: 'Start with the story number.', example: 'STRY0010231 - Loaner reminders' }]);
    expect(conventionsPrompt(inst)).toBe('');
    conventions.approve('inst-1', conventions.get('inst-1')!.proposed);
    expect(conventionsPrompt(inst)).toContain('"Start with the story number." (e.g. "STRY0010231 - Loaner reminders")');
    conventions.clear('inst-1');
    expect(conventionsPrompt(inst)).toBe('');
  });
});
