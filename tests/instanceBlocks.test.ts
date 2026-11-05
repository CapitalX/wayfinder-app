import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MessageBlocks, prettyTool } from '../src/web/components/Blocks.tsx';
import type { Block } from '../src/web/api.ts';

const render = (blocks: Block[]) => renderToStaticMarkup(createElement(MessageBlocks, { blocks, onPreview: () => {} }));
describe('instance labels and approvals', () => {
  it.each([
    ['mcp__instance__query_records', {}, 'instance · query_records'],
    ['mcp__nowaikit__query_records', {}, 'instance · query_records'],
    ['mcp__nowaikit__run_tool', { name: 'get_record' }, 'instance · get_record'],
  ])('renders new and saved tool blocks: %s', (name, input, label) => {
    expect(prettyTool(name, input)).toBe(label);
    const html = render([{ type: 'tool', id: 't', name, input, status: 'done', result: '{}' }]);
    expect(html).toContain(label);
    expect(html).not.toContain('nowaikit');
  });
  it('shows Delete, the target, and where the change lands', () => {
    const html = render([{ type: 'approval', id: 'a', tool: 'mcp__instance__delete_record', input: { kind: 'record', action: 'delete', table: 'incident', sys_id: 'a'.repeat(32), record: 'INC0010001', lands_in: { update_set: 'Incident work', application: 'Global' } } }]);
    for (const text of ['Delete', 'incident', 'INC0010001', 'a'.repeat(32), 'Incident work']) expect(html).toContain(text);
  });
  it('shows the entire script, including the end of a long script, for approval', () => {
    const script = '// start\n' + 'gs.info("hello");\n'.repeat(500) + '// end-of-script';
    const html = render([{ type: 'approval', id: 'a', tool: 'mcp__instance__run_script', input: { script, why: 'Count the affected records' } }]);
    expect(html).toContain('Run this script on the instance (like Scripts - Background)');
    expect(html).toContain('Count the affected records');
    expect(html).toContain('<pre class="script"');
    expect(html).toContain('// start');
    expect(html).toContain('// end-of-script');
    expect((html.match(/gs.info/g) ?? []).length).toBe(500);
  });
  it.each([
    { name: 'execute_background_script', arguments: { script: 'go();\ndone();', scope: 'global' } },
    { script: 'go();\ndone();', scope: 'global' },
  ])('extracts scripts from saved approvals and keeps other fields', (input) => {
    const html = render([{ type: 'approval', id: 'a', tool: 'mcp__nowaikit__run_tool', input }]);
    expect(html).toContain('go();\ndone();</pre>');
    expect(html).toContain('global');
    expect(html).not.toContain('\\n');
  });
  it('renders code fields and long multiline record values as scripts', () => {
    const html = render([{ type: 'approval', id: 'a', tool: 'mcp__instance__update_record', input: {
      kind: 'record', action: 'update', table: 'sys_script', changes: {
        script: 'go();\ndone();', condition: 'current.active', description: 'a'.repeat(81) + '\nend', name: 'Rule',
      },
    } }]);
    expect((html.match(/class="script"/g) ?? []).length).toBe(3);
    expect(html).toContain('go();\ndone();');
    expect(html).toContain('<td>Rule</td>');
  });

});
