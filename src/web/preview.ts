import { useEffect, useState } from 'react';

// Mockup previews: a mockup is drawn at a real device size (its logical viewport) and then scaled to fit the space it
// has, so a narrow panel never pushes a desktop design into its phone layout.

export type Device = 'desktop' | 'tablet' | 'phone';
export const VIEWPORTS: Record<Device, { w: number; h: number; label: string }> = {
  desktop: { w: 1440, h: 900, label: 'Desktop' },
  tablet: { w: 820, h: 1180, label: 'Tablet' },
  phone: { w: 390, h: 844, label: 'Phone' },
};

// What a preview may load, enforced by the browser instead of trusted to the prompt: no network at all (no remote
// scripts, styles, fonts, images, fetch or form posts), only what's inline in the mockup. The frame is also
// sandboxed without same-origin, so it can't read Wayfinder's cookies or call its API, and the app's own CSP
// (frame-src blob: data:) stops it navigating to a remote page.
export const PREVIEW_CSP = [
  "default-src 'none'", "style-src 'unsafe-inline'", "script-src 'unsafe-inline'", 'img-src data: blob:', 'font-src data:',
  'media-src data: blob:', "connect-src 'none'", "form-action 'none'", "base-uri 'none'", "frame-src 'none'",
].join('; ');
const META = `<meta http-equiv="Content-Security-Policy" content="${PREVIEW_CSP}">`;

// The policy goes first in <head> so it applies before anything loads, and after the doctype so the page keeps
// standards mode. The saved mockup and its download stay exactly as written.
export function withPreviewPolicy(html: string): string {
  const head = /<head(\s[^>]*)?>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + META + html.slice(head.index + head[0].length);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) return doctype[0] + `<head>${META}</head>` + html.slice(doctype[0].length);
  return `<head>${META}</head>` + html;
}

// A blob URL for the preview, revoked when the HTML changes or the frame goes away (no leak per revision).
export function usePreviewUrl(html: string | null): string {
  const [url, setUrl] = useState('');
  useEffect(() => {
    if (html === null) { setUrl(''); return; }
    const u = URL.createObjectURL(new Blob([withPreviewPolicy(html)], { type: 'text/html;charset=utf-8' }));
    setUrl(u);
    return () => URL.revokeObjectURL(u);
  }, [html]);
  return url;
}

// Download the mockup as written; the URL lives only for the click.
export function downloadHtml(html: string, name = 'mockup.html') {
  const u = URL.createObjectURL(new Blob([html], { type: 'text/html;charset=utf-8' }));
  const a = document.createElement('a');
  a.href = u; a.download = name;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(u), 1000);
}

// How much to shrink the viewport: never above 100%; 'fit' fits both sides, 'width' only the width.
export function fitScale(vp: { w: number; h: number }, box: { w: number; h: number }, mode: 'fit' | 'width'): number {
  if (box.w <= 0) return 1;
  const sw = box.w / vp.w;
  const s = mode === 'width' || box.h <= 0 ? sw : Math.min(sw, box.h / vp.h);
  return Math.min(1, Math.max(0.05, s));
}
