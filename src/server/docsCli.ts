import { docsSource } from './docs.ts';
import { freeBytes, gb, localInfo, NEED_BYTES, setupDocs } from './docsLocal.ts';
import { DOCS_DIR } from './config.ts';
import { redact } from './docsIndex.ts';

// `wayfinder docs setup [--release <family>] [--instance <family>]`, `wayfinder docs update`, `wayfinder docs status`.
// Runs from the app folder like the server, with the same data folder.
const [cmd = 'status', ...rest] = process.argv.slice(2);
const flag = (name: string) => { const i = rest.indexOf(`--${name}`); return i >= 0 ? rest[i + 1] : undefined; };

function status() {
  const have = localInfo();
  const src = docsSource();
  if (src === 'server') console.log('Answers use the docs server set up on this machine (SNDOCS_URL); the local docs are a fallback.');
  if (!have.length) { console.log(`No local docs yet. Set them up with: wayfinder docs setup   (needs git and about ${gb(NEED_BYTES)} free)`); return; }
  for (const r of have) console.log(`${r.release}: ${Number(r.docs ?? 0).toLocaleString()} pages, indexed ${r.indexed_at ?? '?'}, ${gb(r.bytes)} (${DOCS_DIR})`);
}

if (cmd === 'status') status();
else if (cmd === 'setup' || cmd === 'update') {
  const update = cmd === 'update';
  if (!update) console.log(`Downloading ServiceNow's public docs (github.com/ServiceNow/ServiceNowDocs, Apache-2.0) and indexing them on this machine.\nUses about 1.5 GB in ${DOCS_DIR}; ${gb(freeBytes())} free there now. Takes a few minutes.`);
  let last = '';
  try {
    const r = await setupDocs({ release: flag('release'), instance: flag('instance'), update, onProgress: (step, detail) => {
      const line = detail ? `${step}: ${detail}` : step;
      if (line !== last) { last = line; console.log(`  ${line}`); }
    } });
    console.log(update ? `Updated ${r.release}: ${r.indexed} pages changed, ${r.removed} removed.` : `The ${r.release} docs are ready. Pip cites them from the next answer on; no restart needed.`);
  } catch (e) {
    console.error(`wayfinder docs: ${redact((e as Error).message)}`);
    process.exit(1);
  }
} else {
  console.error('usage: wayfinder docs setup [--release <family>] | update | status');
  process.exit(2);
}
