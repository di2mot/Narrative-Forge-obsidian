import { create, insert, remove, search, Orama } from "@orama/orama";
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
  characters: string;
  filename: string;
}

export class VectorDatabase {
  private db: Orama | null = null;
  private embedder: any = null;
  private currentModelName: string = MULTILINGUAL_MODEL;
  private initPromise: Promise<void> | null = null;

  async init(modelName?: string): Promise<void> {
    // Serialize concurrent callers so the 80–150 MB WASM model is only loaded once.
    if (this.initPromise) return this.initPromise;
    this.initPromise = this._doInit(modelName).finally(() => { this.initPromise = null; });
    return this.initPromise;
  }

  private async _doInit(modelName?: string): Promise<void> {
    const resolved = modelName ? resolveEmbeddingModel(modelName) : this.currentModelName;
    if (resolved !== this.currentModelName) {
      this.currentModelName = resolved;
      this.embedder = null; // model changed — reload
    }

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
          characters: "string",
          filename: "string"
        }
      });
    }

    if (!this.embedder) {
      const onnxBackend = (env.backends as any)?.onnx;
      if (onnxBackend) {
        if (!onnxBackend.wasm) onnxBackend.wasm = {};
        onnxBackend.wasm.numThreads = 1;
        // __dirname in Electron renderer points into the asar archive, not the plugin dir.
        // Use explicit CDN paths so onnxruntime-web always finds the WASM files.
        if (!onnxBackend.wasm.wasmPaths) {
          onnxBackend.wasm.wasmPaths = "https://cdn.jsdelivr.net/npm/@huggingface/transformers@3.8.1/dist/";
        }
      }
      console.log("[Narrative Forge] Loading embedding model:", this.currentModelName);
      // ort-wasm-simd-threaded.jsep.mjs does `await import("worker_threads")` when
      // process.versions.node is a string. The Electron renderer has node integration,
      // so this fires — but the .mjs is fetched as a remote ES module, and the browser
      // loader can't resolve bare Node specifiers. Hide process.versions.node for the
      // duration of model load so the glue takes the browser path instead.
      const proc = (globalThis as any).process;
      const origNodeVersion = proc?.versions?.node;
      if (proc?.versions && origNodeVersion !== undefined) {
        try { delete proc.versions.node; } catch { proc.versions.node = undefined; }
      }
      try {
        this.embedder = await pipeline("feature-extraction", this.currentModelName, {
          device: "wasm",
          dtype: "q8",
          progress_callback: (_info: any) => {}
        });
      } finally {
        if (proc?.versions && origNodeVersion !== undefined) {
          proc.versions.node = origNodeVersion;
        }
      }
      console.log("[Narrative Forge] Model loaded successfully");
    }
  }

  async embed(text: string): Promise<number[]> {
    if (!this.embedder || !this.db) await this.init();
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
    const results = await search(this.db!, {
      mode: "vector",
      vector: {
        value: queryEmbedding,
        property: "embedding"
      },
      limit,
      similarity: 0.2
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
        this.db = await restore("json", serialized) as unknown as Orama;
        console.log("[Narrative Forge] Restored Orama DB from disk");
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
