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
    const r = applyLspEdit(content, 6, 0, 6, 0, 'x');
    expect(r).toEqual(expect.objectContaining({ error: expect.stringMatching(/Invalid range: file has 4 lines/) }));
  });

  it('returns error when end_line < start_line', () => {
    const r = applyLspEdit(content, 3, 0, 2, 0, 'x');
    expect(r).toEqual(expect.objectContaining({ error: expect.stringMatching(/Invalid range: file has 4 lines/) }));
  });

  it('allows end_line = lineCount + 1 to mean "after the last line" (LSP exclusive end)', () => {
    // 4-line content (3 lines + trailing empty): inserting at the very end is valid.
    const out = applyLspEdit(content, 4, 0, 4, 0, 'extra\n');
    expect(typeof out).toBe('string');
  });

  it('replaces lines N..M when end_line=M+1, end_char=0 (LSP exclusive end)', () => {
    // Replace lines 1–2 inclusive: end_line should be 3 (line 3 preserved)
    expect(applyLspEdit(content, 1, 0, 3, 0, 'NEW1\nNEW2\n'))
      .toBe('NEW1\nNEW2\nline three\n');
  });

  it('LSP correctness: replacing lines 2–4 of a 4-line file uses end_line=5', () => {
    // Mirrors the user-reported scenario: a paragraph is lines 2–4; model wants
    // to replace it with a polished version. Correct call passes end_line one
    // PAST the last replaced line, with new_text providing its own newlines.
    const file = 'header\nold para 1\nold para 2\nЧас спати.\n';
    const newText = 'new para 1\nnew para 2\nЧас спати.\n';
    const out = applyLspEdit(file, 2, 0, 5, 0, newText);
    expect(out).toBe('header\nnew para 1\nnew para 2\nЧас спати.\n');
    expect((typeof out === 'string' ? out.match(/Час спати/g) : null)?.length ?? 0).toBe(1);
  });

  it('documents the model-misuse case that produces duplication', () => {
    // If the model misuses end_line (passes the last line it WANTS replaced with
    // end_char=0), LSP exclusive-end semantics preserve that line. If new_text
    // also ends with that line content, the result has the line twice. The fix
    // is the system prompt — see edit_scene tool description.
    const file = 'header\nold\nЧас спати.\n';
    const newText = 'new\nЧас спати.';
    const out = applyLspEdit(file, 2, 0, 3, 0, newText);
    // Line 3 ('Час спати.') was preserved per LSP semantics; new_text also
    // ended with that line → duplication. Demonstrated, not desired.
    expect((typeof out === 'string' ? out.match(/Час спати/g) : null)?.length ?? 0).toBe(2);
  });
});
