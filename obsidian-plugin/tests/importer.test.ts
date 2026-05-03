import { describe, it, expect } from 'vitest';
import { hashContent, reindexDecision } from '../src/importer';
import type { FileHashEntry } from '../src/importer';

describe('hashContent', () => {
  it('returns a 64-char hex string', async () => {
    const h = await hashContent('hello');
    expect(h).toHaveLength(64);
    expect(h).toMatch(/^[0-9a-f]+$/);
  });

  it('is deterministic for the same input', async () => {
    expect(await hashContent('abc')).toBe(await hashContent('abc'));
  });

  it('differs for different content', async () => {
    expect(await hashContent('abc')).not.toBe(await hashContent('abd'));
  });
});

describe('reindexDecision', () => {
  const entry: FileHashEntry = { mtime: 1000, hash: 'abc', chunkIds: ['a', 'b'] };

  it('returns reindex when no cache entry exists', () => {
    expect(reindexDecision(undefined, 1000, 'abc')).toBe('reindex');
  });

  it('returns skip when mtime matches (fast path)', () => {
    expect(reindexDecision(entry, 1000, 'xyz')).toBe('skip');
  });

  it('returns update-mtime when mtime differs but hash matches', () => {
    expect(reindexDecision(entry, 2000, 'abc')).toBe('update-mtime');
  });

  it('returns reindex when both mtime and hash differ', () => {
    expect(reindexDecision(entry, 2000, 'xyz')).toBe('reindex');
  });
});
