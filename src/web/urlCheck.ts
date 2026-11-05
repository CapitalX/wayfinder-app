// The instance address check the server makes (src/server/instanceUrl.ts), early, while the user types: only https.
// Plain http to this machine is left to the server, which allows it only for a local test instance.
export function urlProblem(raw: string): string {
  const text = raw.trim();
  if (!text) return '';
  const scheme = text.match(/^([a-z][a-z0-9+.-]*):\/\//i)?.[1]?.toLowerCase();
  if (!scheme || scheme === 'https') return '';
  if (scheme === 'http' && /^http:\/\/(127\.0\.0\.1|localhost)(:\d+)?\/?$/i.test(text)) return '';
  return 'Use an https:// address, so your sign-in details are never sent unencrypted.';
}
