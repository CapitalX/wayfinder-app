// Auto mode on the home box: a quick, free guess at which mode a request belongs to. It only picks where the chat
// starts (the mode can be changed in the chat header); a guessed Build is confirmed before anything runs.
export type HomeMode = 'build' | 'explore' | 'mockup' | 'decide' | 'debug';

const RULES: [HomeMode, RegExp][] = [
  ['mockup', /\b(mock ?up|sketch|wireframe|prototype (a|the)? ?(screen|page|form)|what (would|could) .* look like|design (a|the|my) (form|page|screen|workspace|portal|list|dashboard))\b/i],
  ['debug', /\b(error|errors|broken|not working|doesn'?t work|isn'?t working|fail(s|ed|ing)?|stuck|bug|why (is|does|did|isn'?t|doesn'?t|won'?t)|(INC|CHG|PRB|RITM|REQ)\d{5,}|nobody is|no one is|wrong)\b/i],
  ['decide', /\b(should (i|we)|vs\.?|versus|or (a|an|the)? ?\w+ \?|which (is|one|approach|option)|decide|trade-?offs?|compare|pros and cons|better to)\b/i],
  ['build', /\b(build|create|make|develop|scaffold)\b[^.?!]{0,60}\b(app|application|tracker|portal|catalog item|table|module|integration|workflow|system)\b|^(an?|my) [\w\s-]{2,40} (app|tracker)\b/i],
];

export function inferMode(text: string): HomeMode {
  const t = text.trim();
  for (const [mode, re] of RULES) if (re.test(t)) return mode;
  return 'explore';
}
