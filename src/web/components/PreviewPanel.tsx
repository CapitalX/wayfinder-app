import { useState } from 'react';
import { downloadHtml, type Device } from '../preview.ts';
import { PreviewControls, PreviewFrame, PreviewFullscreen, type Zoom } from './PreviewFrame.tsx';

// Shows a mockup in a sandboxed frame (no same-origin access, no network), laid out at a real device size and scaled
// to the panel, so a narrow panel never turns a desktop design into its phone layout.
export function PreviewPanel({ html, onClose }: { html: string; onClose: () => void }) {
  const [device, setDevice] = useState<Device>('desktop');
  const [zoom, setZoom] = useState<Zoom>('fit');
  const [scale, setScale] = useState(1);
  const [full, setFull] = useState(false);
  return (
    <aside className="preview">
      <div className="preview-head">
        <strong>Preview</strong>
        <button className="icon-btn" onClick={onClose} aria-label="Close preview">×</button>
      </div>
      <p className="panel-intro pad">A mockup drawn in the chat, shown at a real screen size. Pick a device; Download keeps a copy as a web page.</p>
      <div className="preview-tools">
        <PreviewControls device={device} setDevice={setDevice} zoom={zoom} setZoom={setZoom} scale={scale} />
        <span className="preview-actions">
          <button className="link" onClick={() => setFull(true)}>Full screen</button>
          <button className="link" onClick={() => downloadHtml(html)}>Download</button>
        </span>
      </div>
      <PreviewFrame html={html} device={device} zoom={zoom} title="Mockup preview" onScale={setScale} />
      {full && <PreviewFullscreen html={html} device={device} onClose={() => setFull(false)} />}
    </aside>
  );
}
