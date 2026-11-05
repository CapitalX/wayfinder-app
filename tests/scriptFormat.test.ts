import { describe, expect, it } from 'vitest';
import { formatScript } from '../src/web/components/ScriptBlock.tsx';

const padding = '/*' + ' padding '.repeat(30) + '*/';
describe('approval script display', () => {
  it('preserves already readable scripts', () => {
    const script = 'if (ready) {\n\tgo();\n}\n';
    expect(formatScript(script)).toBe(script);
  });
  it('indents compact scripts without splitting for headers', () => {
    expect(formatScript(`for(var i=0;i<2;i++){go();done();}${padding}`))
      .toBe(`for(var i=0;i<2;i++){\n  go();\n  done();\n}\n${padding}`);
  });
  it('formats statements inside an immediately invoked function', () => {
    expect(formatScript(`(function(){go();done();})();${padding}`)).toContain('  go();\n  done();');
  });
  it('preserves literal and comment contents', () => {
    const literals = ['"a;{\\\"}"', "'a;{\\\'}'", '`a;{\n}`', '/[{};\\/]/g'];
    for (const literal of literals) {
      const result = formatScript(`if(ok){var x=${literal};/* { ; } */go();// } ; {\ndone();}${padding}`);
      expect(result).toContain(`var x=${literal};`);
      expect(result).toContain('/* { ; } */');
      expect(result).toContain('// } ; {\n');
      expect(result).toContain('\n  done();');
    }
  });
  it('falls back when delimiters or literal boundaries are uncertain', () => {
    for (const body of ['if(ok){go();', 'if(ok)){go();}', 'var x="unterminated;', 'var x=`${`nested`}`;', 'var x=a/b;']) {
      const script = body + padding;
      expect(formatScript(script)).toBe(script);
    }
  });
});
