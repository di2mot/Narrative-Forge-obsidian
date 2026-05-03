# Plugin Performance Improvements Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Add incremental (hash-based) vector DB indexing and LSP-style line/character editing to the Obsidian plugin.

**Architecture:** Two independent improvements: (A) `importBookLocally` now accepts a `fileHashes` cache from `data.json`, skips unchanged files via mtime→SHA-256 check, and removes only stale Orama docs instead of clearing the whole DB; (C) `edit_scene` replaces the fragile `old_text` matching with `{start_line, start_char, end_line, end_char}` LSP coordinates, and `read_chapter`/`read_scene` now emit file-relative line numbers.

**Tech Stack:** TypeScript, Obsidian API, `@orama/orama` (vector DB), Web Crypto API (`crypto.subtle`), Vitest (new, for unit tests)

---

## File Map

| File | What changes |
|------|-------------|
| `obsidian-plugin/src/database.ts` | Add `removeChunks(ids: string[])` method |
| `obsidian-plugin/src/importer.ts` | Add `FileHashEntry`, `hashContent`, `reindexDecision`; rewrite `importBookLocally` signature + body |
| `obsidian-plugin/src/tools.ts` | Add `applyLspEdit`, `addLineNumbers`; rewrite `edit_scene`, update `read_scene`, `read_chapter` |
| `obsidian-plugin/src/agent.ts` | Update `TOOL_DEFINITIONS` `edit_scene` entry (OPENAI/GEMINI auto-derive from it) |
| `obsidian-plugin/src/main.ts` | Update 3 call sites: `startupReindex`, `runImport`, `registerAutoImport` — load/save hash cache |
| `obsidian-plugin/tests/importer.test.ts` | New — unit tests for `hashContent`, `reindexDecision` |
| `obsidian-plugin/tests/tools.test.ts` | New — unit tests for `applyLspEdit`, `addLineNumbers` |
| `obsidian-plugin/vitest.config.ts` | New — vitest configuration |

---

## Task 0: Set up Vitest

**Files:**
- Create: `obsidian-plugin/vitest.config.ts`
- Modify: `obsidian-plugin/package.json`
- Create: `obsidian-plugin/tests/sanity.test.ts`

- [ ] **Step 1: Install vitest**

```bash
cd obsidian-plugin && npm install --save-dev vitest
```

Expected: `vitest` appears in `devDependencies` in `package.json`.

- [ ] **Step 2: Add test scripts to `package.json`**

In `obsidian-plugin/package.json`, add to `"scripts"`:
```json
"test": "vitest run",
"test:watch": "vitest"
```

- [ ] **Step 3: Create `obsidian-plugin/vitest.config.ts`**

```typescript
import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
});
```

- [ ] **Step 4: Create `obsidian-plugin/tests/sanity.test.ts`**

```typescript
import { describe, it, expect } from 'vitest';

describe('sanity', () => {
  it('runs', () => expect(1 + 1).toBe(2));
});
```

- [ ] **Step 5: Run tests to verify setup**

```bash
cd obsidian-plugin && npm test
```

Expected output includes: `1 passed`

- [ ] **Step 6: Commit**

```bash
git add obsidian-plugin/vitest.config.ts obsidian-plugin/package.json obsidian-plugin/package-lock.json obsidian-plugin/tests/sanity.test.ts
git commit -m "chore: add vitest test runner to obsidian plugin"
```

---

## Task 1: Add `removeChunks` to `VectorDatabase`

**Files:**
- Modify: `obsidian-plugin/src/database.ts`

- [ ] **Step 1: Add `remove` to the Orama import**

In `obsidian-plugin/src/database.ts`, find the import line that includes `create, insert, search` from `@orama/orama` and add `remove`:

```typescript
import { create, insert, remove, search, persist, restore } from "@orama/orama";
```

(The exact existing imports may differ — add `remove` if it isn't already there.)

- [ ] **Step 2: Add `removeChunks` method to `VectorDatabase`**

Insert after the `clear` method (around line 116):

```typescript
async removeChunks(ids: string[]): Promise<void> {
  if (!this.db || ids.length === 0) return;
  for (const id of ids) {
    try {
      await remove(this.db!, id);
    } catch {
      // ignore — chunk may have been removed already
    }
  }
}
```

- [ ] **Step 3: Build to confirm no TypeScript errors**

```bash
cd obsidian-plugin && npm run build 2>&1 | head -30
```

Expected: build succeeds (no type errors in database.ts).

- [ ] **Step 4: Commit**

```bash
git add obsidian-plugin/src/database.ts obsidian-plugin/main.js
git commit -m "feat: add VectorDatabase.removeChunks for targeted Orama doc removal"
```

---

## Task 2: Hash utilities in `importer.ts` (TDD)

**Files:**
- Modify: `obsidian-plugin/src/importer.ts`
- Create: `obsidian-plugin/tests/importer.test.ts`

- [ ] **Step 1: Write the failing tests**

Create `obsidian-plugin/tests/importer.test.ts`:

```typescript
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
```

- [ ] **Step 2: Run tests — confirm they fail**

```bash
cd obsidian-plugin && npm test
```

Expected: tests fail with "Cannot find module '../src/importer'" or "hashContent is not exported".

- [ ] **Step 3: Add `FileHashEntry`, `hashContent`, `reindexDecision` to `importer.ts`**

Add the following at the top of `obsidian-plugin/src/importer.ts`, before the existing imports:

```typescript
export interface FileHashEntry {
  mtime: number;
  hash: string;
  chunkIds: string[];
}

export async function hashContent(content: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(content);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

export type ReindexDecision = 'skip' | 'update-mtime' | 'reindex';

export function reindexDecision(
  cached: FileHashEntry | undefined,
  mtime: number,
  hash: string
): ReindexDecision {
  if (!cached) return 'reindex';
  if (cached.mtime === mtime) return 'skip';
  if (cached.hash === hash) return 'update-mtime';
  return 'reindex';
}
```

- [ ] **Step 4: Run tests — confirm they pass**

```bash
cd obsidian-plugin && npm test
```

Expected: `7 passed` (1 sanity + 3 hashContent + 4 reindexDecision).

- [ ] **Step 5: Commit**

```bash
git add obsidian-plugin/src/importer.ts obsidian-plugin/tests/importer.test.ts
git commit -m "feat: add FileHashEntry type and hash utilities to importer"
```

---

## Task 3: Rewrite `importBookLocally` for incremental indexing

**Files:**
- Modify: `obsidian-plugin/src/importer.ts`

- [ ] **Step 1: Replace the body of `importBookLocally`**

In `obsidian-plugin/src/importer.ts`, replace the entire `exportasync function importBookLocally(...)` (currently lines 35–84) with:

```typescript
export async function importBookLocally(
  app: App,
  bookDir: string,
  force: boolean = false,
  embeddingModel?: string,
  hashCache: Record<string, FileHashEntry> = {}
): Promise<{ chapters_imported: number; updated_cache: Record<string, FileHashEntry> }> {
  const relBookDir = toVaultRelative(app, bookDir);
  const folderPath = relBookDir ? `${relBookDir}/chapters` : "chapters";
  const files = app.vault.getFiles().filter(
    f => f.path.startsWith(folderPath + "/") && f.extension === "md"
  );

  if (files.length === 0) {
    throw new Error(`Chapters folder not found or empty at ${folderPath}`);
  }

  const modelName = embeddingModel ? resolveEmbeddingModel(embeddingModel) : undefined;

  if (force) {
    await vectorDb.clear(modelName);
    hashCache = {};
  } else {
    await vectorDb.init(modelName);
  }

  const updatedCache: Record<string, FileHashEntry> = { ...hashCache };

  // Remove stale cache entries for deleted files
  const currentPaths = new Set(files.map(f => f.path));
  for (const cachedPath of Object.keys(updatedCache)) {
    if (!currentPaths.has(cachedPath)) {
      await vectorDb.removeChunks(updatedCache[cachedPath].chunkIds);
      delete updatedCache[cachedPath];
    }
  }

  let imported = 0;

  for (const file of files) {
    const content = await app.vault.read(file);
    const hash = await hashContent(content);
    const decision = reindexDecision(updatedCache[file.path], file.stat.mtime, hash);

    if (decision === 'skip') continue;

    if (decision === 'update-mtime') {
      updatedCache[file.path] = { ...updatedCache[file.path], mtime: file.stat.mtime };
      continue;
    }

    // 'reindex': remove old Orama docs, re-parse and re-embed
    if (updatedCache[file.path]) {
      await vectorDb.removeChunks(updatedCache[file.path].chunkIds);
    }

    const chapter = parseChapter(content, file.name);
    if (!chapter) continue;

    const newChunkIds: string[] = [];
    for (let sceneIdx = 0; sceneIdx < chapter.scenes.length; sceneIdx++) {
      const scene = chapter.scenes[sceneIdx];
      if (!scene.text.trim()) continue;
      const chunks = splitWords(scene.text, CHUNK_WORDS, CHUNK_OVERLAP);
      for (let ckIdx = 0; ckIdx < chunks.length; ckIdx++) {
        const id = `ch${String(chapter.number).padStart(4, "0")}_sc${String(sceneIdx).padStart(4, "0")}_ck${String(ckIdx).padStart(4, "0")}`;
        await vectorDb.addSceneChunk(id, chunks[ckIdx], {
          chapter: chapter.number,
          chapter_title: chapter.title,
          scene_index: sceneIdx,
          location: scene.location,
          characters: scene.characters.join(","),
          filename: chapter.filename
        });
        newChunkIds.push(id);
      }
    }

    updatedCache[file.path] = { mtime: file.stat.mtime, hash, chunkIds: newChunkIds };
    imported++;
  }

  await vectorDb.saveToFile(app, relBookDir);
  return { chapters_imported: imported, updated_cache: updatedCache };
}
```

- [ ] **Step 2: Build to verify no TypeScript errors**

```bash
cd obsidian-plugin && npm run build 2>&1 | head -30
```

Expected: TypeScript error on the 3 call sites in `main.ts` that still pass the old signature (no `hashCache`, and don't destructure the return value). This is expected — Task 4 fixes them.

- [ ] **Step 3: Commit (even with build errors — they're expected and will be fixed next)**

```bash
git add obsidian-plugin/src/importer.ts
git commit -m "feat: incremental importBookLocally with mtime+hash cache"
```

---

## Task 4: Wire hash cache into `main.ts`

**Files:**
- Modify: `obsidian-plugin/src/main.ts`

This task updates the 3 call sites that call `importBookLocally`: `startupReindex`, `runImport`, and `registerAutoImport`. All three load the cache before calling, and save the updated cache after.

- [ ] **Step 1: Update the import statement for `importBookLocally`**

Find the import of `importBookLocally` in `obsidian-plugin/src/main.ts` and add `FileHashEntry`:

```typescript
import { importBookLocally, FileHashEntry } from "./importer";
```

- [ ] **Step 2: Update `startupReindex` (lines 708–775)**

Find the `try` block near line 769 that calls `importBookLocally`. Replace:

```typescript
    try {
      await importBookLocally(this.app, absBookDir, false, this.settings.embeddingModel);
      console.log(`[Narrative Forge] Startup reindex done: ${bookRoot || "vault root"}`);
    } catch (e) {
      console.error("Startup reindex failed:", e);
    }
```

With:

```typescript
    try {
      const pluginData = (await this.loadData()) || {};
      const bookCache: Record<string, FileHashEntry> = pluginData.fileHashes?.[absBookDir] ?? {};
      const { updated_cache } = await importBookLocally(
        this.app, absBookDir, false, this.settings.embeddingModel, bookCache
      );
      const currentData = (await this.loadData()) || {};
      await this.saveData({
        ...currentData,
        fileHashes: { ...(currentData.fileHashes || {}), [absBookDir]: updated_cache }
      });
      console.log(`[Narrative Forge] Startup reindex done: ${bookRoot || "vault root"}`);
    } catch (e) {
      console.error("Startup reindex failed:", e);
    }
```

- [ ] **Step 3: Update `runImport` (lines 777–791)**

Replace the entire `runImport` method body:

```typescript
  async runImport(force = false): Promise<void> {
    const notice = new Notice("Narrative Forge: Importing locally...", 0);
    const absDir = this.getAbsoluteBookDir();
    try {
      const pluginData = (await this.loadData()) || {};
      const bookCache: Record<string, FileHashEntry> = force
        ? {}
        : (pluginData.fileHashes?.[absDir!] ?? {});
      const result = await importBookLocally(
        this.app, absDir, force, this.settings.embeddingModel, bookCache
      );
      const currentData = (await this.loadData()) || {};
      await this.saveData({
        ...currentData,
        fileHashes: { ...(currentData.fileHashes || {}), [absDir!]: result.updated_cache }
      });
      notice.hide();
      new Notice(`Narrative Forge: Imported ${result.chapters_imported} chapter(s) into local vector database.`);
      void this.reloadCharacterCache();
    } catch (err) {
      notice.hide();
      new Notice(`Narrative Forge: Local import failed — ${err}`);
    }
  }
```

- [ ] **Step 4: Update `registerAutoImport` (lines 660–702)**

Find the inner `if (isChapterFile)` block (around line 690) and replace:

```typescript
          if (isChapterFile) {
            const absDir = this.getAbsoluteBookDir();
            if (absDir) {
              importBookLocally(this.app, absDir, false, this.settings.embeddingModel).catch((e) => {
                console.warn("[Narrative Forge] Auto-reindex failed:", e);
              });
            }
          }
```

With:

```typescript
          if (isChapterFile) {
            const absDir = this.getAbsoluteBookDir();
            if (absDir) {
              (async () => {
                try {
                  const pluginData = (await this.loadData()) || {};
                  const bookCache: Record<string, FileHashEntry> =
                    pluginData.fileHashes?.[absDir] ?? {};
                  const { updated_cache } = await importBookLocally(
                    this.app, absDir, false, this.settings.embeddingModel, bookCache
                  );
                  const currentData = (await this.loadData()) || {};
                  await this.saveData({
                    ...currentData,
                    fileHashes: { ...(currentData.fileHashes || {}), [absDir]: updated_cache }
                  });
                } catch (e) {
                  console.warn("[Narrative Forge] Auto-reindex failed:", e);
                }
              })();
            }
          }
```

- [ ] **Step 5: Build — confirm no TypeScript errors**

```bash
cd obsidian-plugin && npm run build 2>&1 | head -30
```

Expected: clean build, no errors.

- [ ] **Step 6: Commit**

```bash
git add obsidian-plugin/src/main.ts obsidian-plugin/main.js
git commit -m "feat: wire hash cache into all importBookLocally call sites"
```

---

## Task 5: LSP edit utilities in `tools.ts` (TDD)

**Files:**
- Modify: `obsidian-plugin/src/tools.ts`
- Create: `obsidian-plugin/tests/tools.test.ts`

- [ ] **Step 1: Write failing tests**

Create `obsidian-plugin/tests/tools.test.ts`:

```typescript
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
  // 'line one\nline two\nline three\n' → lines: ['line one','line two','line three',''] (4 elements)
  const content = 'line one\nline two\nline three\n';

  it('replaces a substring within a line', () => {
    // replace 'one' (chars 5–8) on line 1 with 'ONE'
    expect(applyLspEdit(content, 1, 5, 1, 8, 'ONE'))
      .toBe('line ONE\nline two\nline three\n');
  });

  it('replaces a whole line', () => {
    // replace all of line 2 'line two' (chars 0–8) with 'replaced'
    expect(applyLspEdit(content, 2, 0, 2, 8, 'replaced'))
      .toBe('line one\nreplaced\nline three\n');
  });

  it('replaces across multiple lines', () => {
    // from line 1 char 5 to line 2 char 4 → replaces 'one\nline' with 'X\nY'
    expect(applyLspEdit(content, 1, 5, 2, 4, 'X\nY'))
      .toBe('line X\nY two\nline three\n');
  });

  it('inserts at a point (empty range)', () => {
    // insert ' inserted' after char 4 on line 1
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
```

- [ ] **Step 2: Run tests — confirm they fail**

```bash
cd obsidian-plugin && npm test
```

Expected: fail with "applyLspEdit is not exported" / "addLineNumbers is not exported".

- [ ] **Step 3: Add `addLineNumbers` and `applyLspEdit` to `tools.ts`**

Add the following before the `const DIALOGUE_RE` line at the top of `obsidian-plugin/src/tools.ts`:

```typescript
export function addLineNumbers(text: string, startLine: number = 1): string {
  const lines = text.split('\n');
  const lastNum = startLine + lines.length - 1;
  const width = String(lastNum).length;
  return lines
    .map((line, i) => `${String(startLine + i).padStart(width, ' ')}: ${line}`)
    .join('\n');
}

export type LspEditResult = string | { error: string };

export function applyLspEdit(
  content: string,
  startLine: number,
  startChar: number,
  endLine: number,
  endChar: number,
  newText: string
): LspEditResult {
  const lines = content.split('\n');
  if (startLine < 1 || endLine < startLine || endLine > lines.length) {
    return { error: `Invalid range: file has ${lines.length} lines.` };
  }
  const prefix = lines[startLine - 1].slice(0, startChar);
  const suffix = lines[endLine - 1].slice(endChar);
  const newLines = newText.split('\n');
  newLines[0] = prefix + newLines[0];
  newLines[newLines.length - 1] += suffix;
  return [
    ...lines.slice(0, startLine - 1),
    ...newLines,
    ...lines.slice(endLine),
  ].join('\n');
}
```

- [ ] **Step 4: Run tests — confirm they pass**

```bash
cd obsidian-plugin && npm test
```

Expected: `13 passed` (1 sanity + 7 importer + 3 addLineNumbers + 6 applyLspEdit, adjust if counts differ).

- [ ] **Step 5: Commit**

```bash
git add obsidian-plugin/src/tools.ts obsidian-plugin/tests/tools.test.ts
git commit -m "feat: add applyLspEdit and addLineNumbers pure functions"
```

---

## Task 6: Update `edit_scene`, `read_scene`, `read_chapter` in `tools.ts`

**Files:**
- Modify: `obsidian-plugin/src/tools.ts`

- [ ] **Step 1: Replace `edit_scene` method (lines 103–124)**

```typescript
  async edit_scene(args: {
    filename: string;
    start_line: number;
    start_char: number;
    end_line: number;
    end_char: number;
    new_text: string;
  }): Promise<string> {
    const file = this.getFile(args.filename);
    if (!file) return `File not found: ${args.filename}. Available folders: chapters/, notes/`;

    const content = await this.app.vault.read(file);
    const result = applyLspEdit(
      content,
      args.start_line, args.start_char,
      args.end_line, args.end_char,
      args.new_text
    );

    if (typeof result === 'object') return result.error;

    await this.app.vault.modify(file, result);
    const oldLineCount = args.end_line - args.start_line + 1;
    const newLineCount = args.new_text.split('\n').length;
    return `Replaced lines ${args.start_line}:${args.start_char}–${args.end_line}:${args.end_char} in ${args.filename} (${oldLineCount} → ${newLineCount} lines).`;
  }
```

- [ ] **Step 2: Update `read_chapter` (lines 91–100) to emit line numbers**

```typescript
  async read_chapter(args: { filename: string }): Promise<string> {
    const file = this.getFile(args.filename);
    if (!file) return `File not found: ${args.filename}. Available folders: chapters/, notes/`;
    const content = await this.app.vault.read(file);
    const MAX_CHARS = 8000;
    if (content.length > MAX_CHARS) {
      return addLineNumbers(content.slice(0, MAX_CHARS)) +
        `\n\n[NOTE: Content truncated at ${MAX_CHARS} chars. Use read_scene with scene_index for specific scenes.]`;
    }
    return addLineNumbers(content);
  }
```

- [ ] **Step 3: Update `read_scene` (lines 74–89) to emit file-relative line numbers**

`scene.line_start` is 0-indexed relative to the file body (after frontmatter). To get file-relative line numbers, count the frontmatter lines and add the offset.

```typescript
  async read_scene(args: { filename: string; scene_index: number }): Promise<string> {
    const file = this.getFile(args.filename);
    if (!file) return `File not found: ${args.filename}. Available folders: chapters/, notes/`;

    const content = await this.app.vault.read(file);
    const chapter = parseChapter(content, file.name);
    if (!chapter) return "Failed to parse file.";

    const idx = args.scene_index;
    if (idx >= chapter.scenes.length) {
      return `Scene ${idx} not found. Chapter has ${chapter.scenes.length} scenes.`;
    }

    const scene = chapter.scenes[idx];

    // Compute file-relative start line: frontmatter lines + body-relative scene.line_start (both 0-indexed), +1 for 1-indexed output
    const fmMatch = content.match(/^---\n[\s\S]*?\n---\n/);
    const fmLineCount = fmMatch ? fmMatch[0].split('\n').length - 1 : 0;
    const fileLineStart = fmLineCount + scene.line_start + 1;

    return `[Scene ${idx} — ${scene.location} — ${scene.timeline}]\n${addLineNumbers(scene.text, fileLineStart)}`;
  }
```

- [ ] **Step 4: Build — confirm no TypeScript errors**

```bash
cd obsidian-plugin && npm run build 2>&1 | head -30
```

Expected: clean build.

- [ ] **Step 5: Run all tests — confirm still passing**

```bash
cd obsidian-plugin && npm test
```

Expected: all tests pass.

- [ ] **Step 6: Commit**

```bash
git add obsidian-plugin/src/tools.ts obsidian-plugin/main.js
git commit -m "feat: LSP-style edit_scene and line-numbered read_chapter/read_scene"
```

---

## Task 7: Update `TOOL_DEFINITIONS` in `agent.ts`

**Files:**
- Modify: `obsidian-plugin/src/agent.ts`

`OPENAI_TOOLS` and `GEMINI_TOOLS` both derive from `TOOL_DEFINITIONS` automatically — only one change needed.

- [ ] **Step 1: Replace the `edit_scene` entry in `TOOL_DEFINITIONS` (lines 27–37)**

Find and replace:

```typescript
  {
    name: "edit_scene",
    description: "Edit a specific scene in a chapter file by replacing exact text. The old_text must match exactly what is in the file.",
    input_schema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "Chapter filename" },
        old_text: { type: "string", description: "The exact text to replace" },
        new_text: { type: "string", description: "The replacement text" },
      },
      required: ["filename", "old_text", "new_text"],
    },
  },
```

With:

```typescript
  {
    name: "edit_scene",
    description: "Edit text in a chapter file using precise line and character positions (LSP-style). Always call read_chapter first to see the file with file-relative line numbers, then specify the exact range to replace. start_char and end_char are 0-indexed within the line; end_char is exclusive.",
    input_schema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "Chapter filename e.g. '01-siege.md'" },
        start_line: { type: "integer", description: "Start line number (1-indexed, inclusive)" },
        start_char: { type: "integer", description: "Start character offset on start_line (0-indexed, inclusive)" },
        end_line: { type: "integer", description: "End line number (1-indexed, inclusive)" },
        end_char: { type: "integer", description: "End character offset on end_line (0-indexed, exclusive)" },
        new_text: { type: "string", description: "Replacement text (may span multiple lines)" },
      },
      required: ["filename", "start_line", "start_char", "end_line", "end_char", "new_text"],
    },
  },
```

- [ ] **Step 2: Update the `read_scene` description to mention line numbers**

Find and replace the `read_scene` description:

```typescript
    description: "Read the raw text of a specific scene from a chapter file. Use this to get the exact text before editing.",
```

With:

```typescript
    description: "Read a specific scene with file-relative line numbers. For editing, prefer read_chapter which shows the full file with line numbers — use those coordinates with edit_scene.",
```

- [ ] **Step 3: Build — confirm no TypeScript errors**

```bash
cd obsidian-plugin && npm run build 2>&1 | head -30
```

Expected: clean build.

- [ ] **Step 4: Commit**

```bash
git add obsidian-plugin/src/agent.ts obsidian-plugin/main.js
git commit -m "feat: update edit_scene tool schema to LSP-style line/char coordinates"
```

---

## Task 8: End-to-end smoke test

**Files:** none — manual verification only

- [ ] **Step 1: Run full test suite**

```bash
cd obsidian-plugin && npm test
```

Expected: all tests pass.

- [ ] **Step 2: Build production bundle**

```bash
cd obsidian-plugin && npm run build
```

Expected: `main.js` regenerated with no errors.

- [ ] **Step 3: Deploy to vault (if `NOS_VAULT_PLUGIN_DIR` is set)**

```bash
cd obsidian-plugin && NOS_VAULT_PLUGIN_DIR="<your-vault>/.obsidian/plugins/narrative-os" npm run build
```

- [ ] **Step 4: Verify incremental indexing in Obsidian**

1. Open Obsidian, open a chapter file, make a small edit, save
2. Open DevTools console (Ctrl+Shift+I) — confirm no `[Narrative Forge] Auto-reindex failed` errors
3. Run **Import book** command (force=false) — should say "0 chapter(s) imported" if nothing changed since last save
4. Run **Import book** again — still 0 (no re-embedding on identical content)
5. Inspect vault's `data.json` — should have a `fileHashes` key with entries per chapter file

- [ ] **Step 5: Verify LSP editing**

In the Narrative Forge chat, ask the agent to:
1. Call `read_chapter` on a chapter file → output should have line numbers like `1: ---`
2. Call `edit_scene` with valid `start_line`/`start_char`/`end_line`/`end_char` → should return a "Replaced lines N:M–N:M" message
3. Call `edit_scene` with `start_line: 999` → should return `Invalid range: file has X lines.`

- [ ] **Step 6: Final commit (if any last fixes)**

```bash
git add -A
git commit -m "fix: smoke test fixes"
```
