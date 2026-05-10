import { describe, it, expect } from 'vitest';
import { parseChapter, stripWikilinks, parseWikilinkList } from '../src/parser';

describe('stripWikilinks', () => {
  it('strips [[..]] wrapping', () => {
    expect(stripWikilinks('[[Forest]]')).toBe('Forest');
  });

  it('passes plain text through', () => {
    expect(stripWikilinks('Mountain')).toBe('Mountain');
  });
});

describe('parseWikilinkList', () => {
  it('returns [] for empty input', () => {
    expect(parseWikilinkList(undefined)).toEqual([]);
    expect(parseWikilinkList(null)).toEqual([]);
  });

  it('handles array input', () => {
    expect(parseWikilinkList(['[[Foo]]', 'Bar'])).toEqual(['Foo', 'Bar']);
  });

  it('wraps a single string into an array', () => {
    expect(parseWikilinkList('[[Solo]]')).toEqual(['Solo']);
  });
});

describe('parseChapter', () => {
  it('returns a Chapter with frontmatter and a single scene from a minimal file', () => {
    const md = [
      '---',
      'chapter: 1',
      'title: First',
      'status: draft',
      '---',
      'Scene body text.',
    ].join('\n');

    const chap = parseChapter(md, 'ch01.md');
    expect(chap).not.toBeNull();
    expect(chap!.number).toBe(1);
    expect(chap!.title).toBe('First');
    expect(chap!.status).toBe('draft');
    expect(chap!.filename).toBe('ch01.md');
    expect(chap!.scenes).toHaveLength(1);
    expect(chap!.scenes[0].text).toBe('Scene body text.');
  });

  it('splits scenes on --- separators', () => {
    const md = [
      '---',
      'chapter: 2',
      'title: Two',
      '---',
      'Scene one.',
      '---',
      'Scene two.',
    ].join('\n');

    const chap = parseChapter(md, 'ch02.md');
    expect(chap!.scenes).toHaveLength(2);
    expect(chap!.scenes[0].text).toBe('Scene one.');
    expect(chap!.scenes[1].text).toBe('Scene two.');
  });

  it('extracts dialogue lines and characters', () => {
    const md = [
      '---',
      'chapter: 3',
      '---',
      '[character: Rey] — Where are we?',
      '[character: Freya] — I do not know.',
      '[character: Rey] — Then we walk.',
    ].join('\n');

    const chap = parseChapter(md, 'ch03.md');
    expect(chap!.scenes[0].dialogue).toHaveLength(3);
    expect(chap!.scenes[0].dialogue[0]).toEqual({ character: 'Rey', text: 'Where are we?' });
    expect(chap!.scenes[0].characters).toEqual(['Rey', 'Freya']);
  });

  it('inherits chapter-level location/timeline into scene metadata', () => {
    const md = [
      '---',
      'chapter: 4',
      'location: Andruil',
      'timeline: Year 1105',
      '---',
      'Body.',
    ].join('\n');

    const chap = parseChapter(md, 'ch04.md');
    expect(chap!.scenes[0].location).toBe('Andruil');
    expect(chap!.scenes[0].timeline).toBe('Year 1105');
  });

  it('seeds scene.characters from frontmatter `characters:` even when no dialogue tags', () => {
    const md = [
      '---',
      'chapter: 7',
      'characters: [Rey, Freya, "[[Sam]]"]',
      '---',
      'Pure narrative scene with no dialogue.',
    ].join('\n');

    const chap = parseChapter(md, 'ch07.md');
    expect(chap!.scenes[0].characters).toEqual(['Rey', 'Freya', 'Sam']);
  });

  it('parses comma-separated `characters:` scalar from frontmatter', () => {
    const md = [
      '---',
      'chapter: 8',
      'characters: Rey, Freya, Sam',
      '---',
      'Body.',
    ].join('\n');

    const chap = parseChapter(md, 'ch08.md');
    expect(chap!.scenes[0].characters).toEqual(['Rey', 'Freya', 'Sam']);
  });

  it('overrides scene.characters from scene-level `characters::` Dataview metadata', () => {
    const md = [
      '---',
      'chapter: 9',
      'characters: [Rey, Freya]',
      '---',
      'First scene.',
      '---',
      'characters:: Sam, [[Trond]]',
      'location:: Cave',
      'Second scene body — no dialogue.',
    ].join('\n');

    const chap = parseChapter(md, 'ch09.md');
    expect(chap!.scenes).toHaveLength(2);
    expect(chap!.scenes[0].characters).toEqual(['Rey', 'Freya']);
    expect(chap!.scenes[1].characters).toEqual(['Sam', 'Trond']);
  });

  it('merges dialogue characters into the seeded list without duplicates', () => {
    const md = [
      '---',
      'chapter: 10',
      'characters: [Rey]',
      '---',
      'Narration.',
      '[character: Rey] — already in list',
      '[character: Freya] — newly named',
    ].join('\n');

    const chap = parseChapter(md, 'ch10.md');
    expect(chap!.scenes[0].characters).toEqual(['Rey', 'Freya']);
  });

  it('overrides location/timeline from scene-level Dataview metadata', () => {
    const md = [
      '---',
      'chapter: 5',
      'location: Forest',
      '---',
      'Opening scene.',
      '---',
      'location:: Cave',
      'timeline:: Next day',
      'Second scene body.',
    ].join('\n');

    const chap = parseChapter(md, 'ch05.md');
    expect(chap!.scenes).toHaveLength(2);
    expect(chap!.scenes[0].location).toBe('Forest');
    expect(chap!.scenes[1].location).toBe('Cave');
    expect(chap!.scenes[1].timeline).toBe('Next day');
  });

  it('handles a file with no frontmatter', () => {
    const chap = parseChapter('Just some prose.', 'plain.md');
    expect(chap).not.toBeNull();
    expect(chap!.number).toBe(0);
    expect(chap!.title).toBe('plain');
    expect(chap!.scenes).toHaveLength(1);
  });

  it('skips empty scenes between separators', () => {
    const md = [
      '---',
      'chapter: 6',
      '---',
      'Scene A.',
      '---',
      '',
      '---',
      'Scene B.',
    ].join('\n');

    const chap = parseChapter(md, 'ch06.md');
    expect(chap!.scenes).toHaveLength(2);
    expect(chap!.scenes[0].text).toBe('Scene A.');
    expect(chap!.scenes[1].text).toBe('Scene B.');
  });
});
