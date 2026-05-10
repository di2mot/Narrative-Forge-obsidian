import { create, insert, remove, search } from "@orama/orama";
import { persist, restore } from "@orama/plugin-data-persistence";
import { pipeline, env } from "@huggingface/transformers";
import type { App } from "obsidian";

env.allowLocalModels = false;
env.useBrowserCache = true;

export const EN_MODEL = "Xenova/all-MiniLM-L6-v2";
export const MULTILINGUAL_MODEL = "Xenova/paraphrase-multilingual-MiniLM-L12-v2";

export function resolveEmbeddingModel(setting: string): string {
  if (setting === "en") return EN_MODEL;
  if (setting === "multilingual") return MULTILINGUAL_MODEL;
  return setting; // already a full model name
}

export interface SceneMetadata {
  chapter: number;
  chapter_title: string;
  scene_index: number;
  location: string;
  characters: string[];
  filename: string;
}

export class VectorDatabase {
  private db: any = null;
  private embedder: any = null;
  private currentModelName: string = MULTILINGUAL_MODEL;
  private initPromise: Promise<void> | null = null;

  async init(modelName?: string): Promise<void> {
    const resolved = modelName ? resolveEmbeddingModel(modelName) : this.currentModelName;
    
    if (resolved !== this.currentModelName) {
      if (this.initPromise) await this.initPromise;
      this.currentModelName = resolved;
      this.db = null;
      this.embedder = null;
      this.initPromise = null;
    }

    if (this.initPromise) return this.initPromise;
    
    this.initPromise = this._doInit(resolved).finally(() => {
      // We keep the promise if it's successful so subsequent calls are fast,
      // but we need to be able to clear it on model switch.
      // Actually, it's safer to just clear it and rely on this.db check in _doInit.
      this.initPromise = null;
    });
    return this.initPromise;
  }

  private async _doInit(modelName?: string): Promise<void> {
    const targetModel = modelName || this.currentModelName;
    if (!this.db) {
      this.db = await create({
        schema: {
          id: "string",
          text: "string",
          embedding: "vector[384]",
          chapter: "number",
          chapter_title: "string",
          scene_index: "number",
          location: "string",
          characters: "string[]",
          filename: "string"
        }
      }) as any;
    }

    if (!this.embedder) {
      const onnxBackend = (env.backends as any)?.onnx;
      if (onnxBackend) {
        if (!onnxBackend.wasm) onnxBackend.wasm = {};
        onnxBackend.wasm.numThreads = 1;
        // CDN path MUST match the @huggingface/transformers version pinned in
        // package.json — the JS glue and the .wasm binary are coupled.
        onnxBackend.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/";
      }

      // Hide node version to force browser-friendly WASM loading in Electron
      const proc = (globalThis as any).process;
      const origNodeVersion = proc?.versions?.node;
      if (proc?.versions && origNodeVersion !== undefined) {
        try { proc.versions.node = undefined; } catch { }
      }

      try {
        this.embedder = await pipeline("feature-extraction", targetModel, {
          device: "wasm",
          dtype: "q8",
        });
      } finally {
        if (proc?.versions && origNodeVersion !== undefined) {
          try { proc.versions.node = origNodeVersion; } catch { }
        }
      }
    }
  }

  async embed(text: string): Promise<number[]> {
    if (!this.embedder) await this.init();
    const output = await this.embedder(text, { pooling: "mean", normalize: true });
    return Array.from(output.data);
  }

  async addSceneChunk(id: string, text: string, meta: SceneMetadata) {
    if (!this.db) await this.init();
    const embedding = await this.embed(text);
    await insert(this.db!, {
      id,
      text,
      embedding,
      chapter: meta.chapter,
      chapter_title: meta.chapter_title,
      scene_index: meta.scene_index,
      location: meta.location,
      characters: meta.characters,
      filename: meta.filename
    });
  }

  async searchSemantic(query: string, limit: number = 5) {
    if (!this.db) await this.init();
    const queryEmbedding = await this.embed(query);
    // Pure-vector search. Multilingual MiniLM cosine scores typically run lower
    // than English-only — keep the threshold permissive (0.25) so non-English
    // queries don't return zero hits.
    const results = await search(this.db!, {
      mode: "vector",
      vector: {
        value: queryEmbedding,
        property: "embedding"
      },
      similarity: 0.25,
      limit
    });
    return results.hits.map(hit => ({
      id: hit.document.id,
      text: hit.document.text,
      metadata: {
        chapter: hit.document.chapter,
        chapter_title: hit.document.chapter_title,
        scene_index: hit.document.scene_index,
        location: hit.document.location,
        characters: hit.document.characters,
        filename: hit.document.filename
      },
      score: hit.score
    }));
  }

  async searchByMetadata(where: Record<string, any>, limit: number = 20) {
    if (!this.db) await this.init();
    const results = await search(this.db!, {
      where,
      limit,
    });
    return results.hits.map(hit => ({
      id: hit.document.id,
      text: hit.document.text,
      metadata: {
        chapter: hit.document.chapter,
        chapter_title: hit.document.chapter_title,
        scene_index: hit.document.scene_index,
        location: hit.document.location,
        characters: hit.document.characters,
        filename: hit.document.filename
      },
      score: hit.score
    }));
  }

  async listChapters() {
    if (!this.db) return [];
    const results = await search(this.db!, { term: "", limit: 5000 });
    const chapters = new Map<number, { chapter: number; title: string; filename: string }>();
    for (const hit of results.hits) {
      const d = hit.document;
      if (!chapters.has(d.chapter)) {
        chapters.set(d.chapter, {
          chapter: d.chapter,
          title: d.chapter_title,
          filename: d.filename
        });
      }
    }
    return Array.from(chapters.values()).sort((a, b) => a.chapter - b.chapter);
  }

  async listCharacters() {
    if (!this.db) return [];
    const results = await search(this.db!, { term: "", limit: 5000 });
    const chars = new Set<string>();
    for (const hit of results.hits) {
      const cArr = hit.document.characters;
      if (Array.isArray(cArr)) {
        cArr.forEach((s: string) => {
          if (s) chars.add(s.trim());
        });
      }
    }
    return Array.from(chars).sort();
  }

  async clear(modelName?: string) {
    this.db = null;
    await this.init(modelName);
  }

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

  /** Save to vault — bookDir must be vault-relative. */
  async saveToFile(app: App, vaultRelBookDir: string) {
    if (!this.db) return;
    try {
      const serialized = await persist(this.db, "json");
      const dbPath = vaultRelBookDir ? `${vaultRelBookDir}/.narrative-orama.json` : ".narrative-orama.json";
      await app.vault.adapter.write(dbPath, serialized as string);
    } catch (e) {
      console.error("Failed to save Orama DB:", e);
    }
  }

  /** Load from vault — bookDir must be vault-relative. Loads embedder without recreating DB. */
  async loadFromFile(app: App, vaultRelBookDir: string, modelName?: string) {
    const resolved = modelName ? resolveEmbeddingModel(modelName) : null;
    if (resolved && resolved !== this.currentModelName) {
      this.currentModelName = resolved;
      this.embedder = null;
    }

    const dbPath = vaultRelBookDir
      ? `${vaultRelBookDir}/.narrative-orama.json`
      : ".narrative-orama.json";

    if (await app.vault.adapter.exists(dbPath)) {
      try {
        const serialized = await app.vault.adapter.read(dbPath);
        this.db = await restore("json", serialized) as any;
        // Load embedder without recreating the restored DB — reuse _doInit's WASM setup
        if (!this.embedder) {
          await this._doInit();
        }
      } catch (e) {
        console.error("Failed to restore Orama DB:", e);
        await this.init(modelName);
      }
    } else {
      await this.init(modelName);
    }
  }
}

export const vectorDb = new VectorDatabase();
