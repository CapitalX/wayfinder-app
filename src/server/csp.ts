// The page's Content-Security-Policy. Live HTML views are blob iframes, so they inherit it too.
// Images load only from the app itself, data: and blob:. Any web address would let an answer carry data out in an image
// URL (text planted in a record can ask for one), and the browser fetches it before anyone clicks.
export const CSP = "default-src 'self'; img-src 'self' data: blob:; style-src 'self' 'unsafe-inline'; frame-src blob: data:; connect-src 'self'; base-uri 'none'; form-action 'self'";
