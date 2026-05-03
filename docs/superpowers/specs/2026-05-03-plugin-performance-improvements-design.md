# Plugin Performance Improvements Design

**Date:** 2026-05-03  
**Status:** Approved  
**Scope:** Obsidian plugin (`obsidian-plugin/src/`)

## Problem

As a book grows beyond ~100 chapters, three bottlenecks emerge:

1. **Full re-index on every save** — `importBookLocally` calls `vectorDb.clear()` and re-embeds all chapters whenever any `.md` file in `chapters/` is saved. For a 100-chapter book this re-processes chapters that haven't changed.
2. **Imprecise scene editing** — `edit_scene` relies on exact `old_text` string matching. If the LLM passes even a single wrong character, the edit fails silently with an unhelpful error.
3. **Main-thread embedding** — the Transformers.js pipeline runs on the main thread and can freeze the Obsidian UI during large imports. (Deferred — see section B.)

## Implementation Order

**A → C → B** (B deferred until A ships and we can measure remaining freeze time).

---

## A — Incremental Indexing

### Goal

Only re-embed files whose content actually changed since the last import.

### Hash Cache Schema

Stored under a new top-level key in `data.json` (managed by Obsidian's `loadData`/`saveData`), keyed by book path so multiple books are supported:

```typescript
interface FileHashEntry {
  mtime: number;     // fast-path: skip hash if mtime unchanged
  hash: string;      // SHA-256 of file content (hex string)
  chunkIds: string[]; // all Orama doc IDs for this file, for targeted removal
}

// Added to plugin data (not NarrativePluginSettings)
fileHashes: {
  [bookPath: string]: {
    [filePath: string]: FileHashEntry;
  }
}
```

### Algorithm (per import run, `force=false`)

```
load cache = plugin.loadData().fileHashes[bookPath] ?? {}

for each .md file in chapters/:
  if file.stat.mtime === cache[file.path].mtime:
    skip                                    // fast path
  
  content = vault.read(file)
  hash = hex(await crypto.subtle.digest('SHA-256', encode(content)))
  
  if hash === cache[file.path].hash:
    cache[file.path].mtime = file.stat.mtime  // mtime drifted, content same
    skip
  
  // content changed — re-embed
  vectorDb.removeChunks(cache[file.path].chunkIds ?? [])
  newChunkIds = re-parse and re-embed file, collect inserted IDs
  cache[file.path] = { mtime: file.stat.mtime, hash, chunkIds: newChunkIds }

// clean up deleted files
for each key in cache not in current file list:
  vectorDb.removeChunks(cache[key].chunkIds)
  delete cache[key]

plugin.saveData({ ...data, fileHashes: { ...allHashes, [bookPath]: cache } })
```

`force=true` clears `fileHashes[bookPath]` entirely and calls `vectorDb.clear()` before running.

### Interface Changes

**`importBookLocally` signature:**
```typescript
export async function importBookLocally(
  app: App,
  bookDir: string,
  force: boolean,
  embeddingModel: string | undefined,
  hashCache: Record<string, FileHashEntry>,        // in: current cache
): Promise<{
  chapters_imported: number;
  updated_cache: Record<string, FileHashEntry>;    // out: updated cache
}>
```

The plugin class (`main.ts`) owns loading and saving the cache from `data.json`. `importer.ts` remains decoupled from the plugin instance.

**New `VectorDatabase` method:**
```typescript
async removeChunks(ids: string[]): Promise<void>
// calls Orama remove(db, id) for each ID
```

---

## C — LSP-style Line/Character Edit

### Goal

Replace fragile `old_text` exact matching with precise positional editing — the same model used by VS Code / language servers.

### New `edit_scene` Signature

```typescript
edit_scene(args: {
  filename: string;
  start_line: number;   // 1-indexed, inclusive
  start_char: number;   // 0-indexed within the line, inclusive
  end_line: number;     // 1-indexed, inclusive
  end_char: number;     // 0-indexed within the line, exclusive (LSP convention)
  new_text: string;     // replacement text, may span multiple lines
}): Promise<string>
```

`old_text` parameter is removed entirely. This is a breaking change to the tool schema; no migration is needed because the LLM reads the schema fresh each session.

### Implementation

```typescript
const lines = content.split('\n');

// validate
if (start_line < 1 || end_line < start_line ||
    end_line > lines.length ||
    start_char < 0 || end_char < 0)
  return `Invalid range: file has ${lines.length} lines.`;

const prefix = lines[start_line - 1].slice(0, start_char);
const suffix = lines[end_line - 1].slice(end_char);
const newLines = new_text.split('\n');
newLines[0] = prefix + newLines[0];
newLines[newLines.length - 1] += suffix;

const newContent = [
  ...lines.slice(0, start_line - 1),
  ...newLines,
  ...lines.slice(end_line),
].join('\n');

await this.app.vault.modify(file, newContent);
return `Replaced lines ${start_line}:${start_char}–${end_line}:${end_char} in ${filename} (→ ${newLines.length} lines).`;
```

### `read_scene` / `read_chapter` Changes

Both methods prepend 1-indexed file-relative line numbers to every output line so the LLM can identify coordinates:

```
 1: ---
 2: location:: Forest near Andruil
 3: timeline:: Year 1105
 4:
 5: Artur walked through the trees.
 6: [character: Artur] — I need to rest.
```

Line numbers are **file-relative** (not scene-relative) so they map directly to `edit_scene` coordinates without any offset calculation.

---

## B — Web Worker for Embeddings (Deferred)

**Decision:** Implement after A ships. Measure whether a single-chapter re-embed (the new steady state) still causes a noticeable UI freeze.

**If yes**, the approach is a **Blob URL worker**:
- Serialize the `VectorDatabase.embed()` call into a worker script string
- `new Worker(URL.createObjectURL(new Blob([script], { type: 'application/javascript' })))`
- No esbuild changes needed; works within Obsidian's sandboxed renderer
- Communicate via `postMessage` / `onmessage` with a simple `{ text } → { embedding }` protocol

**Trigger to revisit:** user reports visible freeze after A is in production with a large book.

---

## Files Affected

| File | Changes |
|------|---------|
| `obsidian-plugin/src/database.ts` | Add `removeChunks(ids)` method |
| `obsidian-plugin/src/importer.ts` | `FileHashEntry` type definition; incremental hash logic; new `importBookLocally` signature |
| `obsidian-plugin/src/tools.ts` | Replace `edit_scene` signature with line/char params; update `read_scene` and `read_chapter` to emit line-numbered output |
| `obsidian-plugin/src/main.ts` | Load/save `fileHashes` key from `data.json` in `registerAutoImport`; pass cache to `importBookLocally`; `fileHashes` is separate from `NarrativeSettings` — stored as a sibling key in `data.json` |

---

## Non-Goals

- Server-side (`src/narrative_os/`) is unaffected — all changes are in the plugin only
- No UI changes — purely backend/tool logic
- No new npm dependencies required (Web Crypto is built-in; LSP edit is pure string manipulation)
