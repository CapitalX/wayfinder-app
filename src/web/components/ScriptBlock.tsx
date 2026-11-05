// Display only: the original script remains the approval payload.
export function formatScript(script: string): string {
  const lines = script.split('\n');
  if (script.length / lines.length <= 160 && !lines.some((line) => line.length > 200)) return script;
  let out = '', indent = 0;
  const stack: string[] = [];
  const newline = () => { out = out.replace(/[ \t]+$/, ''); if (!out.endsWith('\n')) out += '\n'; };
  const append = (text: string) => { if (!out || out.endsWith('\n')) out += '  '.repeat(indent); out += text; };
  for (let i = 0; i < script.length; i++) {
    const c = script[i];
    if (c === '"' || c === "'" || c === '`' || c === '/') {
      const start = i;
      if (c === '/' && script[i + 1] === '/') {
        while (i < script.length && script[i] !== '\n') i++;
        append(script.slice(start, i));
        newline();
        continue;
      }
      if (c === '/' && script[i + 1] === '*') {
        const end = script.indexOf('*/', i + 2);
        if (end < 0) return script;
        i = end + 1;
      } else {
        // shortcut: ambiguous division and interpolated templates stay verbatim; use a parser if these need formatting.
        if (c === '/' && !/(?:[=(:,!&|?;{\[]|\breturn|\bthrow)\s*$/.test(script.slice(0, i))) return script;
        let inClass = false, closed = false;
        for (i++; i < script.length; i++) {
          if (script[i] === '\\') { i++; continue; }
          if (c === '`' && script.slice(i, i + 2) === '${') return script;
          if (c === '/' && script[i] === '[') inClass = true;
          if (c === '/' && script[i] === ']') inClass = false;
          if (script[i] === c && !inClass) { closed = true; break; }
          if (c !== '`' && /[\r\n]/.test(script[i])) return script;
        }
        if (!closed) return script;
      }
      append(script.slice(start, i + 1));
    } else if (c === '{') {
      stack.push(c); append(c); indent++; newline();
    } else if (c === '}') {
      if (stack.pop() !== '{') return script;
      indent--; newline(); append(c);
      if (!/^[ \t]*(?:[;,).\]}]|else\b|catch\b|finally\b)/.test(script.slice(i + 1))) newline();
    } else if (c === '(' || c === '[') {
      stack.push(c === '(' && /\bfor\s*$/.test(script.slice(0, i)) ? 'for' : c); append(c);
    } else if (c === ')' || c === ']') {
      const opening = stack.pop();
      if (c === ')' ? opening !== '(' && opening !== 'for' : opening !== '[') return script;
      append(c);
    } else if (c === ';') {
      append(c);
      if (!stack.includes('for')) newline();
    } else if (c === '\n') {
      newline();
    } else if (!/[ \t\r]/.test(c) || (out && !out.endsWith('\n'))) {
      append(c);
    }
  }
  return stack.length ? script : out.trimEnd();
}

export function ScriptBlock({ script }: { script: string }) {
  return <pre className="script" tabIndex={0} aria-label="Script">{formatScript(script)}</pre>;
}
