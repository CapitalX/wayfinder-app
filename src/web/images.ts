// Which markdown images render inline. Only ones that need no request to another site: data: images, blob: and the
// app's own paths. A web image would be fetched as soon as the answer renders, so its address could carry data out;
// it shows as a link instead (the page CSP blocks the fetch too).
export function inlineImage(src: string | undefined): boolean {
  const s = (src ?? '').trim();
  if (/^data:image\//i.test(s) || /^blob:/i.test(s)) return true;
  return s.startsWith('/') && !s.startsWith('//') && !s.includes('\\');
}
