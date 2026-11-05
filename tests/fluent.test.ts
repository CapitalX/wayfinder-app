import { readdirSync, readFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { CHEAT_SHEET, DOC_ALIAS, docSection, parseBuild } from '../src/server/fluent.ts';

describe('parseBuild', () => {
  const raw = readFileSync(new URL('./fixtures/build-errors.txt', import.meta.url), 'utf8');
  const { errors } = parseBuild(raw);

  it('finds every error, without colour codes or code frames', () => {
    expect(errors).toHaveLength(4);
    expect(JSON.stringify(errors)).not.toMatch(/\x1b|~~~/);
  });
  it('keeps file, line, column and code', () => {
    expect(errors[1]).toMatchObject({ file: 'src/fluent/case.now.ts', line: 2, col: 78, code: 'TS213' });
    expect(errors[3]).toMatchObject({ file: 'src/fluent/case2.now.ts', line: 1, code: 'TS6133' });
  });
  it('attaches fix hints', () => {
    expect(errors[0].hint).toMatch(/Choices are an object/);
    expect(errors[2].hint).toMatch(/Choices are an object/);
    expect(errors[3].hint).toMatch(/unused import/);
  });
  it('gives plugin failures their file', () => expect(errors[0].file).toBe('src/fluent/case.now.ts'));
  it('reads a clean build as no errors', () => expect(parseBuild('[now-sdk] Build completed successfully').errors).toEqual([]));
});

describe('cheat sheet and docs', () => {
  it('is loaded and covers the common record types', () => {
    for (const k of ['Table(', 'Acl(', 'ApplicationMenu(', 'BusinessRule(', 'TestSuite(']) expect(CHEAT_SHEET).toContain(k);
  });
  it('cuts one section from a page', () => {
    const page = '# Table\nintro\n## Properties\n- name\n### label\n- x\n## Examples\ncode';
    expect(docSection(page, 'properties')).toBe('## Properties\n- name\n### label\n- x');
    expect(docSection(page, 'nothing')).toBe(page);
  });
  it('covers flows: a custom Action with a script step, a Subflow, and a subflow calling a subflow', () => {
    for (const k of ['Action(', 'actionStep.script', 'Subflow(', 'assignSubflowOutputs', 'waitForCompletion']) expect(CHEAT_SHEET).toContain(k);
  });
  it('points every short topic name at a page the SDK has', () => {
    const docs = new URL('../node_modules/@servicenow/sdk/docs/', import.meta.url);
    const pages = new Set((readdirSync(docs, { recursive: true }) as string[]).filter((f) => f.endsWith('.md')).map((f) => f.split('/').pop()!.slice(0, -3)));
    const missing = Object.entries(DOC_ALIAS).filter(([, page]) => !pages.has(page));
    expect(missing).toEqual([]);
    for (const k of ['subflow', 'action', 'flow-logic']) expect(DOC_ALIAS[k]).toBeDefined();
  });
});

describe('cheat sheet self-check', async () => {
  const { sheetFiles, sheetVersion, sameMinor } = await import('../src/server/fluentCheck.ts');
  const { lessonKey } = await import('../src/server/fluentReview.ts');
  it('turns every example section into a file, plus the module the logic imports', () => {
    const files = sheetFiles(CHEAT_SHEET).map((f) => f.path);
    expect(files).toEqual(expect.arrayContaining(['src/fluent/tables.now.ts', 'src/fluent/security.now.ts', 'src/fluent/tests.now.ts', 'src/fluent/flows.now.ts', 'src/server/loan-rules.ts']));
  });
  it('knows which SDK it was verified on', () => {
    expect(sheetVersion(CHEAT_SHEET)).toMatch(/^\d+\.\d+\.\d+$/);
    expect(sameMinor('4.13.6', '4.13.9')).toBe(true);
    expect(sameMinor('4.13.6', '4.14.0')).toBe(false);
  });
  it('groups the same mistake under one lesson regardless of names and numbers', () => {
    expect(lessonKey('TS2322', "Type 'foo' is not assignable to type 'bar' at 12")).toBe(lessonKey('TS2322', "Type 'baz' is not assignable to type 'qux' at 7"));
  });
});
