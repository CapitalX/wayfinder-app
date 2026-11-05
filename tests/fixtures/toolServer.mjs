// A local MCP fixture: discovery only, no instance and no network.
import { createInterface } from 'node:readline';
if (process.argv.includes('--fail')) process.exit(1);
const lines = createInterface({ input: process.stdin });
lines.on('line', (line) => {
  const request = JSON.parse(line);
  if (request.id === undefined || process.argv.includes('--hang')) return;
  const result = request.method === 'initialize'
    ? { protocolVersion: '2024-11-05', capabilities: { tools: {} }, serverInfo: { name: 'fixture', version: '1.0.0' } }
    : request.method === 'tools/list' ? { tools: [{ name: 'lookup', description: 'A fixture tool', inputSchema: { type: 'object' } }] }
    : { content: [{ type: 'text', text: 'fixture result' }] };
  process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }) + '\n');
});
