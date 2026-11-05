import { describe, expect, it } from 'vitest';
import { scrub, scrubText } from '../src/server/scrub.ts';
import { MASK_RESULTS } from '../src/server/agent.ts';

// Placeholder secrets only: shaped like the real thing so the patterns are exercised.
const BEARER = 'Bearer abcdefghijklmnop.qrstuvwx';
// Assembled at run time so the repo's secret scan doesn't flag a fake.
const JWT = ['eyJ' + 'hbGciOiJIUzI1NiJ9', 'eyJ' + 'zdWIiOiIxMjM0NTY3ODkwIn0', 'c2lnbmF0dXJlLXBsYWNlaG9sZGVy'].join('.');

describe('scrubText masks credentials in what Pip reads', () => {
  it('headers, line by line', () => {
    const out = scrubText(`Content-Type: application/json\nAuthorization: ${BEARER}\nCookie: JSESSIONID=abc123; glide_user=xyz\nX-API-Key: k-123456\nX-Request-Id: r-1`);
    expect(out).toContain('Content-Type: application/json');
    expect(out).toContain('Authorization: [masked]');
    expect(out).toContain('Cookie: [masked]');
    expect(out).toContain('X-API-Key: [masked]');
    expect(out).toContain('X-Request-Id: r-1');
    expect(out).not.toMatch(/abc123|abcdefghij|k-123456/);
  });

  it('query strings and form bodies', () => {
    const out = scrubText('GET https://api.example.com/v1/items?limit=5&api_key=AAAA1111&access_token=BBBB2222 grant_type=password&password=hunter22&client_secret=CCCC');
    expect(out).toContain('limit=5');
    expect(out).toContain('grant_type=password');
    expect(out).not.toMatch(/AAAA1111|BBBB2222|hunter22|CCCC/);
  });

  it('JSON fields, including ServiceNow { value, display_value } fields and headers inside log text', () => {
    const rec = { sys_id: 'a'.repeat(32), name: 'Weather API', credential_alias: 'weather_alias', token_url: 'https://id.example.com/token', password: { value: 'p1', display_value: 'p1' }, refresh_token: 'r1', request_headers: `Authorization: ${BEARER}\nAccept: */*` };
    const out = JSON.parse(scrubText(JSON.stringify(rec, null, 2)));
    expect(out).toMatchObject({ sys_id: rec.sys_id, name: 'Weather API', credential_alias: 'weather_alias', token_url: rec.token_url, password: '[masked]', refresh_token: '[masked]' });
    expect(out.request_headers).toBe('Authorization: [masked]\nAccept: */*');
  });

  it('XML bodies, JWTs and key-shaped strings', () => {
    const out = scrubText(`<soap:Header><wsse:Password Type="text">s3cret!</wsse:Password><user>admin</user></soap:Header> id ${JWT} key sk-abcdefghijklmnopqrstuvwxyz`);
    expect(out).toContain('<wsse:Password Type="text">[masked]</wsse:Password>');
    expect(out).toContain('<user>admin</user>');
    expect(out).not.toMatch(/s3cret|eyJhbGci|sk-abcdef/);
  });

  it('masks overly nested output instead of returning an unchecked secret', () => {
    let value: unknown = { password: 'deep-placeholder' };
    for (let i = 0; i < 20; i++) value = { nested: value };
    expect(JSON.stringify(scrub(value))).not.toContain('deep-placeholder');
    expect(scrubText(JSON.stringify(value))).not.toContain('deep-placeholder');
  });

  it('leaves ordinary records and scripts alone', () => {
    const text = JSON.stringify({ records: [{ sys_id: 'b'.repeat(32), short_description: 'Printer down', script: "var gr = new GlideRecord('incident'); gr.query();" }] });
    expect(scrubText(text)).toBe(text);
    expect(scrubText('plain words, nothing secret here')).toBe('plain words, nothing secret here');
  });
});

describe('tool results are masked before the model sees them', () => {
  const run = (tool_response: unknown) => MASK_RESULTS.hooks[0]!({ hook_event_name: 'PostToolUse', tool_name: 'mcp__instance__query_records', tool_input: {}, tool_response, tool_use_id: 't1', session_id: 's', transcript_path: '', cwd: '' } as any, 't1', { signal: new AbortController().signal });

  it('rewrites MCP content that carried a secret', async () => {
    const r: any = await run([{ type: 'text', text: JSON.stringify({ response_headers: `Set-Cookie: glide_session=zzz9` }) }]);
    expect(r.hookSpecificOutput.updatedToolOutput[0].text).toContain('Set-Cookie: [masked]');
    expect(JSON.stringify(r)).not.toContain('zzz9');
  });

  it('leaves clean results untouched', async () => {
    expect(await run([{ type: 'text', text: '{"count":1}' }])).toEqual({});
    const same = { a: 1 };
    expect(scrub(same)).toBe(same);
  });

  it('watches the built-in instance tools', () => expect(new RegExp(MASK_RESULTS.matcher!).test('mcp__instance__query_records')).toBe(true));

  it('watches all MCP results, including user servers, but not native tools', () => {
    for (const name of ['mcp__sndocs__ask', 'mcp__my_tools__lookup']) expect(new RegExp(MASK_RESULTS.matcher!).test(name)).toBe(true);
    expect(new RegExp(MASK_RESULTS.matcher!).test('WebSearch')).toBe(false);
  });
});
