import { apps, chats, instances, jobs, messages, type Instance, type Job, type NoticeCard } from './db.ts';
import { progress, sn, table } from './sn.ts';
import { clearFeatureCache } from './features.ts';

// Polls running CI/CD work every 20 seconds: plugin and store app installs, app removals and ATF runs.
// When one finishes, a note is added to the chat that started it. App installs run in this process and
// finish themselves (see buildTools.ts), so they have no progress id and are skipped here.
const LABEL: Record<string, Job['status']> = { '2': 'successful', '3': 'failed', '4': 'cancelled' };

// ATF results as a card: passed/failed counts and each test with its status and a link.
async function atfCard(inst: Instance, resultsId: string | undefined, title: string): Promise<{ text: string; card?: NoticeCard }> {
  if (!resultsId) return { text: '' };
  try {
    const r = (await sn(inst, `/api/sn_cicd/testsuite/results/${encodeURIComponent(resultsId)}`)).result ?? {};
    const passed = Number(r.rolledup_test_success_count ?? 0);
    const failed = Number(r.rolledup_test_failure_count ?? 0) + Number(r.rolledup_test_error_count ?? 0);
    const skipped = Number(r.rolledup_test_skip_count ?? 0);
    const rows = await table(inst, 'sys_atf_test_result', `parent=${resultsId}^ORtest_suite_result=${resultsId}`, 'sys_id,test.name,status,output', 30).catch(() => []);
    const card: NoticeCard = {
      kind: 'atf', ok: failed === 0, title: failed ? `${title}: ${failed} failed` : `${title}: all passed`,
      stats: [{ label: 'Passed', value: passed, tone: 'good' }, { label: 'Failed', value: failed, tone: failed ? 'bad' : 'plain' }, ...(skipped ? [{ label: 'Skipped', value: skipped, tone: 'warn' as const }] : [])],
      items: (rows as any[]).map((t) => ({ label: t['test.name'] || 'Test', status: /success|pass/i.test(t.status) ? 'pass' as const : /skip/i.test(t.status) ? 'skip' as const : 'fail' as const, href: `${inst.url}/sys_atf_test_result.do?sys_id=${t.sys_id}`, detail: /success|pass/i.test(t.status) ? undefined : String(t.output ?? '').slice(0, 200) })),
      links: [{ label: 'Suite result', href: `${inst.url}/sys_atf_test_suite_result.do?sys_id=${resultsId}` }],
    };
    return { text: ` ${passed} passed, ${failed} failed.`, card };
  } catch { return { text: '' }; }
}

function finishText(job: Job, status: Job['status'], minutes: number, message: string | null, extra: string) {
  const ok = status === 'successful';
  switch (job.kind) {
    case 'plugin': return `Plugin ${job.target} ${ok ? 'finished installing' : status} after ${minutes} min.${ok ? '' : ` ${message ?? ''}`}`;
    case 'store_app': return `Store app ${job.target} ${ok ? 'finished installing' : status} after ${minutes} min.${ok ? '' : ` ${message ?? ''}`}`;
    case 'app_remove': return `${job.target} ${ok ? 'was removed from the PDI' : `could not be fully removed (${status})`} after ${minutes} min.${ok ? ' Its source is kept, so it can be installed again.' : ` ${message ?? ''}`}`;
    case 'atf': return `${job.target} ${ok ? 'finished' : status} after ${minutes} min.${extra}${ok ? '' : ` ${message ?? ''}`}`;
    default: return `${job.target} ${status}.`;
  }
}

async function pollOnce() {
  for (const job of jobs.running()) {
    if (!job.progress_id) continue;
    const inst = instances.get(job.instance_id);
    if (!inst) continue;
    try {
      const p = await progress(inst, job.progress_id);
      const status = LABEL[String(p.status)];
      const message = [p.status_message, p.status_detail, p.error].filter(Boolean).join(' ') || p.status_label;
      if (!status) {
        jobs.update(job.id, { percent: Number(p.percent_complete) || 0, message });
        continue;
      }
      // Removing a Fluent app can end in "failed" while still deleting it; the SDK treats this message as done.
      const removedAnyway = job.kind === 'app_remove' && /Failed to completely delete application/i.test(message ?? '');
      const final: Job['status'] = removedAnyway ? 'successful' : status;
      if (job.kind === 'plugin' || job.kind === 'store_app') clearFeatureCache();
      jobs.update(job.id, { status: final, percent: final === 'successful' ? 100 : Number(p.percent_complete) || 0, message, finished_at: Date.now() });
      if (job.kind === 'app_remove') {
        const app = apps.list().find((a) => a.name === job.target && a.status === 'removing');
        if (app) apps.update(app.id, { status: final === 'successful' ? 'removed' : 'installed', last_output: message });
      }
      const atf = job.kind === 'atf' ? await atfCard(inst, p.links?.results?.id, job.target) : { text: '' };
      const extra = atf.text;
      if (job.chat_id && chats.get(job.chat_id)) {
        const minutes = Math.max(1, Math.round((Date.now() - job.started_at) / 60_000));
        const card: NoticeCard | undefined = atf.card ?? (job.kind === 'app_remove' ? { kind: 'remove', ok: final === 'successful', title: final === 'successful' ? `${job.target} was removed` : `${job.target} couldn't be fully removed`, stats: [{ label: 'Took', value: `${minutes} min` }] } : undefined);
        messages.add(job.chat_id, 'assistant', [{ type: 'notice', level: final === 'successful' ? 'info' : 'error', text: finishText(job, final, minutes, message, extra), ...(card ? { card } : {}) }]);
        chats.update(job.chat_id, {});
      }
    } catch (e) {
      jobs.update(job.id, { message: `Couldn't check progress: ${(e as Error).message}` });
    }
  }
}

let busy = false;
export function startJobPoller() {
  setInterval(() => {
    if (busy) return;
    busy = true;
    pollOnce().finally(() => { busy = false; });
  }, 20_000);
}
