import { App, TFile, FileSystemAdapter } from "obsidian";
import { parseChapter } from "./parser";
import { vectorDb, resolveEmbeddingModel } from "./database";

const CHUNK_WORDS = 150;
const CHUNK_OVERLAP = 30;

function splitWords(text: string, window: number, overlap: number): string[] {
  const words = text.split(/\s+/);
  if (words.length <= window) return [text];
  const chunks: string[] = [];
  const step = window - overlap;
  let start = 0;
  while (start < words.length) {
    const end = start + window;
    chunks.push(words.slice(start, end).join(" "));
    if (end >= words.length) break;
    start += step;
  }
  return chunks;
}

/** Strip vault base path to get a vault-relative path. */
function toVaultRelative(app: App, absPath: string): string {
  const adapter = app.vault.adapter;
  if (adapter instanceof FileSystemAdapter) {
    const base = adapter.getBasePath();
    if (absPath.startsWith(base)) {
      return absPath.slice(base.length).replace(/^\/+/, "");
    }
  }
  return absPath.replace(/^\/+/, "");
}

export async function importBookLocally(
  app: App,
  bookDir: string,
  force: boolean = false,
  embeddingModel?: string
) {
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
  } else {
    // Non-force: still re-indexes everything (no hash tracking yet).
    // clear() resets the db so we start fresh without duplicate entries.
    await vectorDb.clear(modelName);
  }

  let imported = 0;

  for (const file of files) {
    const content = await app.vault.read(file);
    const chapter = parseChapter(content, file.name);
    if (!chapter) continue;

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
      }
    }
    imported++;
  }

  await vectorDb.saveToFile(app, relBookDir);
  return { chapters_imported: imported };
}
