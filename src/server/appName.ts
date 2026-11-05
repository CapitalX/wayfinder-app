// The app name is the user's call: a new app (or a renamed one) is only planned under a name the user has written
// in this chat, e.g. typed it, or answered the interview form ("App name? → Loaner Tracker").
const norm = (s: string) => s.toLowerCase().replace(/[\s _-]+/g, ' ').replace(/[^\p{L}\p{N} ]/gu, '').trim();

export function nameConfirmed(name: string, userTexts: string[]): boolean {
  const n = norm(name);
  if (!n) return false;
  return userTexts.some((t) => ` ${norm(t)} `.includes(` ${n} `));
}

export const NAME_FIRST = 'Ask the user what to call the app before planning it: send a questions form with one text question '
  + '"App name?" whose default is your suggestion (and say which scope it implies). Use the name they give exactly.';
