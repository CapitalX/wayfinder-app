import type { BuildProgress } from '../buildProgress.ts';

// Build mode's live checklist above the conversation on phones: Plan → Write → Build → Install → Test, pulsing on the
// step Pip is doing right now. Wide screens show the timeline in the work area instead.
export function BuildSteps({ progress }: { progress: BuildProgress }) {
  return (
    <div className="build-steps" aria-label="Build progress">
      {progress.steps.map((s, i) => (
        <div key={s.key} className={`step st-${s.state}`}>
          <span className="step-dot" />{s.short}{i < progress.steps.length - 1 && <span className="step-line" />}
        </div>
      ))}
    </div>
  );
}

// While the timeline is closed on a wide screen: one chip in the chat header, "Build · 2 of 5 ›", that opens it again.
export function BuildChip({ progress, onOpen }: { progress: BuildProgress; onOpen: () => void }) {
  const total = progress.steps.length;
  const at = progress.steps.findIndex((s) => s.state !== 'done');
  const step = at < 0 ? null : progress.steps[at];
  const state = step ? step.state : 'done';
  const said = step ? `${step.state === 'error' ? 'stopped at' : 'step'} ${at + 1} of ${total}, ${step.label.toLowerCase()}` : 'all steps done';
  return (
    <button type="button" className={`build-chip st-${state}`} onClick={onOpen} title="Open the build timeline" aria-label={`Build: ${said}. Open the timeline`}>
      <span className="step-dot" aria-hidden />Build · {step ? `${at + 1} of ${total}` : 'done'}<span aria-hidden> ›</span>
    </button>
  );
}

// The same steps as a vertical timeline in the work area, each with what it means, ending in the test score.
export function BuildTimeline({ progress, onClose }: { progress: BuildProgress; onClose: () => void }) {
  const now = progress.steps.find((s) => s.state === 'now' || s.state === 'error');
  const done = progress.steps.every((s) => s.state === 'done');
  return (
    <aside className="preview features build-timeline">
      <div className="preview-head">
        <strong>Build</strong>
        <button className="icon-btn" onClick={onClose} aria-label="Close the build timeline">×</button>
      </div>
      <div className="features-body">
      <p className="panel-intro" aria-live="polite">{done ? 'All steps done.' : now ? `${now.state === 'error' ? 'Stopped at' : 'Now'}: ${now.label.toLowerCase()}.` : 'Waiting to start.'}</p>
      <ol className="bt-steps" aria-label="Build steps">
        {progress.steps.map((s, i) => (
          <li key={s.key} className={`bt-step st-${s.state}`} style={{ ['--i' as string]: i }} aria-current={s.state === 'now' ? 'step' : undefined}>
            <span className="bt-dot" aria-hidden />
            <div>
              <strong>{s.label}</strong>
              <span className="bt-detail">{s.detail}</span>
              <span className="sr-only">{s.state === 'done' ? ' (done)' : s.state === 'now' ? ' (in progress)' : s.state === 'error' ? ' (failed)' : ''}</span>
            </div>
          </li>
        ))}
      </ol>
      {progress.tests && (
        <p className={`bt-score ${progress.tests.failed ? 'bad' : 'good'}`}>
          <b>{progress.tests.passed} of {progress.tests.passed + progress.tests.failed}</b> tests passed
        </p>
      )}
      </div>
    </aside>
  );
}
