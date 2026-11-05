import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { VIEWPORTS, fitScale, usePreviewUrl, type Device } from '../preview.ts';

// A mockup at its real device size. The frame is always VIEWPORTS[device] wide and tall, so the mockup's own layout
// and breakpoints see that size; only the drawing is scaled to the space available. 'fit' shrinks it to fit the box
// ('width' fits the width and lets the height follow), '100' shows it at full size and the stage scrolls.
export type Zoom = 'fit' | '100';

export function PreviewFrame({ html, device, zoom, fit = 'fit', title, onScale }: {
  html: string; device: Device; zoom: Zoom; fit?: 'fit' | 'width'; title: string; onScale?: (s: number) => void;
}) {
  const vp = VIEWPORTS[device];
  const url = usePreviewUrl(html);
  const stage = useRef<HTMLDivElement>(null);
  const [box, setBox] = useState({ w: 0, h: 0 });
  useLayoutEffect(() => {
    const el = stage.current;
    if (!el) return;
    const measure = () => setBox({ w: el.clientWidth, h: el.clientHeight });
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);
  const scale = zoom === '100' ? 1 : fitScale(vp, { w: box.w - 24, h: fit === 'width' ? 0 : box.h - 24 }, fit);
  useEffect(() => { onScale?.(scale); }, [scale, onScale]);
  return (
    <div ref={stage} className={`pf-stage pf-${zoom} pf-${fit}`} style={fit === 'width' && zoom === 'fit' ? { height: vp.h * scale + 24 } : undefined}>
      <div className="pf-box" style={{ width: vp.w * scale, height: vp.h * scale }}>
        {url && (
          <iframe title={title} sandbox="allow-scripts" src={url} data-device={device}
            style={{ width: vp.w, height: vp.h, transform: `scale(${scale})` }} />
        )}
      </div>
    </div>
  );
}

// Device, zoom and the real numbers: "1440 × 900 · 38%".
export function PreviewControls({ device, setDevice, zoom, setZoom, scale }: {
  device: Device; setDevice: (d: Device) => void; zoom: Zoom; setZoom: (z: Zoom) => void; scale: number;
}) {
  const vp = VIEWPORTS[device];
  return (
    <>
      <div className="seg" role="group" aria-label="Device">
        {(Object.keys(VIEWPORTS) as Device[]).map((d) => (
          <button key={d} className={device === d ? 'on' : ''} onClick={() => setDevice(d)}>{VIEWPORTS[d].label}</button>
        ))}
      </div>
      <div className="seg" role="group" aria-label="Zoom">
        <button className={zoom === 'fit' ? 'on' : ''} onClick={() => setZoom('fit')}>Fit</button>
        <button className={zoom === '100' ? 'on' : ''} onClick={() => setZoom('100')}>100%</button>
      </div>
      <span className="pf-dims muted tiny" title="The size the mockup is laid out at, and how much it is scaled to fit">{vp.w} × {vp.h} · {Math.round(scale * 100)}%</span>
    </>
  );
}

// Full screen: the same mockup over the whole window. Esc or × closes it.
export function PreviewFullscreen({ html, device: start, onClose }: { html: string; device: Device; onClose: () => void }) {
  const [device, setDevice] = useState<Device>(start);
  const [zoom, setZoom] = useState<Zoom>('fit');
  const [scale, setScale] = useState(1);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);
  return (
    <div className="pf-full" role="dialog" aria-label="Full-screen preview">
      <div className="preview-head">
        <strong>Preview</strong>
        <PreviewControls device={device} setDevice={setDevice} zoom={zoom} setZoom={setZoom} scale={scale} />
        <button className="icon-btn" onClick={onClose} aria-label="Close full screen">×</button>
      </div>
      <PreviewFrame html={html} device={device} zoom={zoom} title="Full-screen preview" onScale={setScale} />
    </div>
  );
}
