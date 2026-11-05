import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { api } from '../api.ts';

interface Release { version: string; date: string; title: string; items: string[] }
interface About { version: string; changelog: Release[] }

const seenKey = 'snw-seen-version';
const getSeen = () => { try { return localStorage.getItem(seenKey); } catch { return null; } };

// The ⓘ button: release notes from the repo's changelog.json. The dot shows until this browser has seen the
// current version, so anyone running their own copy sees what changed after they update.
export function WhatsNew({ onOpen }: { onOpen?: () => void }) {
  const [about, setAbout] = useState<About | null>(null);
  const [open, setOpen] = useState(false);
  const [seen, setSeen] = useState(getSeen);
  useEffect(() => { api<About>('/about').then(setAbout).catch(() => {}); }, []);

  const show = () => {
    onOpen?.(); // e.g. close the phone sidebar first, so nothing sits over the panel
    setOpen(true);
    if (about) { try { localStorage.setItem(seenKey, about.version); } catch { /* storage unavailable */ } }
  };
  const close = () => { setOpen(false); setSeen(getSeen()); };
  const unread = !!about && seen !== about.version;
  const isNew = (v: string) => (seen ? newer(v, seen) : v === about?.version);

  return (
    <>
      <button className="icon-btn info-btn" title="What's new" aria-label="What's new" onClick={show}>
        ⓘ{unread && <span className="unread" />}
      </button>
      {open && about && createPortal(
        <div className="sheet-back" onClick={close} onKeyDown={(e) => e.key === 'Escape' && close()}>
          <div className="sheet" role="dialog" aria-modal="true" aria-label="What's new" tabIndex={-1} ref={(el) => el?.focus({ preventScroll: true })} onClick={(e) => e.stopPropagation()}>
            <button className="icon-btn sheet-x" onClick={close} aria-label="Close">×</button>
            <div className="ver">Wayfinder {about.version}</div>
            <h2>What's new</h2>
            {about.changelog.map((r) => (
              <div key={r.version} className="release">
                <div className="ver">{r.version} · {r.date}{isNew(r.version) && <span className="new-tag">new</span>}</div>
                <h3>{r.title}</h3>
                <ul>{r.items.map((i, n) => <li key={n}>{i}</li>)}</ul>
              </div>
            ))}
            <div className="credits">
              <div className="ver">About</div>
              <p><strong>Wayfinder</strong>, an open-source ServiceNow workspace. Pip is its face.</p>
              <p>Built with the Claude Agent SDK (Anthropic), the ServiceNow SDK and the Geist typeface (SIL Open Font License).</p>
              <p>ServiceNow is a trademark of ServiceNow, Inc. Wayfinder is independent and not affiliated with or endorsed by ServiceNow.</p>
            </div>
            <div className="row-actions sheet-foot"><button className="primary" onClick={close}>Got it</button></div>
          </div>
        </div>,
        // Drawn on the page itself, not inside the sidebar, so it's never trapped behind it on a phone.
        document.body,
      )}
    </>
  );
}

function newer(a: string, b: string) {
  const pa = a.split('.').map(Number), pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) if ((pa[i] ?? 0) !== (pb[i] ?? 0)) return (pa[i] ?? 0) > (pb[i] ?? 0);
  return false;
}
