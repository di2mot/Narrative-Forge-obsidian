import { describe, it, expect } from 'vitest';
import { applyLspEdit, addLineNumbers } from '../src/tools';

describe('addLineNumbers', () => {
  it('prefixes 1-indexed line numbers', () => {
    expect(addLineNumbers('a\nb\nc')).toBe('1: a\n2: b\n3: c');
  });

  it('accepts a custom start line', () => {
    expect(addLineNumbers('x\ny', 5)).toBe('5: x\n6: y');
  });

  it('pads numbers for alignment when total exceeds 9 lines', () => {
    const content = Array.from({ length: 10 }, (_, i) => `L${i}`).join('\n');
    const lines = addLineNumbers(content).split('\n');
    expect(lines[0]).toBe(' 1: L0');
    expect(lines[9]).toBe('10: L9');
  });
});

describe('applyLspEdit', () => {
  // content splits to: ['line one','line two','line three',''] — 4 elements
  const content = 'line one\nline two\nline three\n';

  it('replaces a substring within a line', () => {
    // 'line one': chars 5–8 = 'one' → 'ONE'
    expect(applyLspEdit(content, 1, 5, 1, 8, 'ONE'))
      .toBe('line ONE\nline two\nline three\n');
  });

  it('replaces a whole line', () => {
    // line 2 'line two' (0–8) → 'replaced'
    expect(applyLspEdit(content, 2, 0, 2, 8, 'replaced'))
      .toBe('line one\nreplaced\nline three\n');
  });

  it('replaces across multiple lines', () => {
    // line 1 char 5 to line 2 char 4: replaces 'one\nline' → 'X\nY'
    expect(applyLspEdit(content, 1, 5, 2, 4, 'X\nY'))
      .toBe('line X\nY two\nline three\n');
  });

  it('inserts at a point (empty range)', () => {
    // insert ' inserted' at line 1 char 4 (after 'line')
    expect(applyLspEdit(content, 1, 4, 1, 4, ' inserted'))
      .toBe('line inserted one\nline two\nline three\n');
  });

  it('returns error for line number beyond file length', () => {
    expect(applyLspEdit(content, 5, 0, 5, 0, 'x'))
      .toEqual({ error: 'Invalid range: file has 4 lines.' });
  });

  it('returns error when end_line < start_line', () => {
    expect(applyLspEdit(content, 3, 0, 2, 0, 'x'))
      .toEqual({ error: 'Invalid range: file has 4 lines.' });
  });
});
