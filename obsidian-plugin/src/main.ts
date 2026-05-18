/**
 * Narrative Forge — main Obsidian plugin entry point.
 */

import { Notice, Plugin, WorkspaceLeaf, TFile, Modal, Setting, normalizePath, FileSystemAdapter, MarkdownView } from "obsidian";
import { NarrativeAPI } from "./api";
import type { Character } from "./api";
import { BackendManager } from "./backend";
import { buildNosPlugin } from "./decorations";
import { buildPendingEditsPlugin } from "./pending_decorations";
import { PendingEditsRegistry } from "./pending_edits";
import { registerContextMenu } from "./context-menu";
import { NarrativeSidebarView } from "./sidebar";
import { NarrativeChatView } from "./chat";
import { NarrativeSettingTab, NarrativeSettings, DEFAULT_SETTINGS } from "./settings";
import { BookManager, BookConfig } from "./book";
import { NarrativeTimelineView } from "./timeline";
import { WritingSession } from "./session";
import { LocalServer } from "./local_server";
import { importBookLocally, FileHashEntry } from "./importer";
import { vectorDb } from "./database";
import { invalidatePromptCache, pingLocalLLM } from "./agent";

// ---------------------------------------------------------------------------
// "Create new book" modal
// ---------------------------------------------------------------------------

class CreateBookModal extends Modal {
  private title = "";
  private folderName = "";
  private onSubmit: (title: string, folderName: string) => void;

  constructor(app: import("obsidian").App, onSubmit: (title: string, folderName: string) => void) {
    super(app);
    this.onSubmit = onSubmit;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Create new book" });

    new Setting(contentEl)
      .setName("Book title")
      .setDesc("The display title of your book.")
      .addText((text) =>
        text.setPlaceholder("My Fantasy Novel").onChange((v) => {
          this.title = v;
          // Auto-fill folder name from title if not manually set
          if (!this.folderName || this.folderName === this.slugify(this.title.slice(0, -1))) {
            this.folderName = this.slugify(v);
          }
        })
      );

    new Setting(contentEl)
      .setName("Folder name")
      .setDesc("Folder that will be created in the vault root.")
      .addText((text) =>
        text.setPlaceholder("my-fantasy-novel").onChange((v) => {
          this.folderName = v;
        })
      );

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText("Create")
        .setCta()
        .onClick(async () => {
          const title = this.title.trim();
          const folder = (this.folderName.trim() || this.slugify(title));
          if (!title) {
            new Notice("Please enter a book title.");
            return;
          }
          this.close();
          this.onSubmit(title, folder || title);
        })
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }

  private slugify(s: string): string {
    return s
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-|-$/g, "");
  }
}

// ---------------------------------------------------------------------------
// Plugin
// ---------------------------------------------------------------------------

export default class NarrativePlugin extends Plugin {
  settings!: NarrativeSettings;
  api!: NarrativeAPI;
  backend!: BackendManager;
  bookManager!: BookManager;
  pendingEditsRegistry!: PendingEditsRegistry;
  cachedCharacters: Character[] = [];

  private autoImportDebounceMap = new Map<string, ReturnType<typeof setTimeout>>();
  private writingSession!: WritingSession;
  private localServer!: LocalServer;
  private currentBookRoot: string | null = null;
  private startupReindexDone = false;
  private reindexInProgress = false;
  lastActiveMdPath: string | null = null;  // last focused .md file path (vault-relative)
  /** Most recent non-empty editor selection. Captured on active-leaf-change so that
   *  chat can read it after focus has moved away from the editor. */
  lastEditorSelection: string = "";
  private previousLeaf: WorkspaceLeaf | null = null;

  getCurrentBookRoot(): string | null {
    return this.currentBookRoot;
  }

  getCurrentBookLanguage(): string {
    return this.getEmbeddingLanguage();
  }

  getEmbeddingLanguage(): string {
    return this.settings.embeddingModel === "en" ? "en" : "uk";
  }

  async onload(): Promise<void> {
    await this.loadSettings();

    // Migrate old 'api' provider to 'anthropic'
    if (this.settings.provider === "api") {
      this.settings.provider = "anthropic";
      await this.saveSettings();
    }
    
    this.localServer = new LocalServer(this.app);
    this.localServer.start(18000);

    this.api = new NarrativeAPI(this.getBackendUrl());
    this.backend = new BackendManager();
    this.bookManager = new BookManager(this.app);

    // ---------------------------------------------------------------------------
    // Managed backend
    // ---------------------------------------------------------------------------

    if (this.settings.backendMode === "managed") {
      const bookDir =
        this.settings.bookDir ||
        (this.app.vault.adapter as unknown as { basePath?: string }).basePath ||
        ".";

      try {
        await this.backend.start(this.settings.pythonPath, bookDir);
        new Notice("Narrative Forge: Starting backend...");

        const ready = await this.backend.waitReady(this.getBackendUrl(), 15000);
        if (ready) {
          new Notice("Narrative Forge: Backend ready.");
        } else {
          new Notice("Narrative Forge: Backend may not be ready — check logs.");
        }
      } catch (err) {
        new Notice(`Narrative Forge: Failed to start backend — ${err}`);
        console.error("[Narrative Forge] Backend start error:", err);
      }
    }

    // ---------------------------------------------------------------------------
    // CM6 Decorations (correct Obsidian pattern)
    // ---------------------------------------------------------------------------

    // Colors are generated from character names via HSL — no API needed
    this.registerEditorExtension(buildNosPlugin({}));

    this.pendingEditsRegistry = new PendingEditsRegistry();
    this.registerEditorExtension(buildPendingEditsPlugin(this.app, this.pendingEditsRegistry));

    // ---------------------------------------------------------------------------
    // Context menu
    // ---------------------------------------------------------------------------

    registerContextMenu(
      this,
      () => this.cachedCharacters,
      () => this.activateChatAndGetView()
    );

    // ---------------------------------------------------------------------------
    // Sidebar views
    // ---------------------------------------------------------------------------

    this.registerView(
      NarrativeSidebarView.VIEW_TYPE,
      (leaf) => new NarrativeSidebarView(leaf, this)
    );

    this.registerView(
      NarrativeChatView.VIEW_TYPE,
      (leaf) => new NarrativeChatView(leaf, this.api, this)
    );

    this.registerView(
      NarrativeTimelineView.VIEW_TYPE,
      (leaf) => new NarrativeTimelineView(leaf, this)
    );

    // ---------------------------------------------------------------------------
    // Writing session tracker (status bar)
    // ---------------------------------------------------------------------------

    this.writingSession = new WritingSession(this);

    // ---------------------------------------------------------------------------
    // Ribbon icons
    // ---------------------------------------------------------------------------

    this.addRibbonIcon("book-open", "Narrative Forge Sidebar", () => {
      void this.activateSidebar();
    });

    this.addRibbonIcon("message-circle", "Narrative Forge Chat", () => {
      void this.activateChat();
    });

    this.addRibbonIcon("clock", "Narrative Timeline", () => {
      void this.activateTimeline();
    });

    // ---------------------------------------------------------------------------
    // Commands
    // ---------------------------------------------------------------------------

    this.addCommand({
      id: "import-book",
      name: "Import book",
      callback: () => void this.runImport(),
    });

    this.addCommand({
      id: "open-chat",
      name: "Open Chat",
      callback: () => void this.activateChat(),
    });

    this.addCommand({
      id: "open-sidebar",
      name: "Open Sidebar",
      callback: () => void this.activateSidebar(),
    });

    this.addCommand({
      id: "test-connection",
      name: "Test backend connection",
      callback: () => void this.testConnection(),
    });

    this.addCommand({
      id: "create-book",
      name: "Create new book",
      callback: () => void this.createNewBook(),
    });

    this.addCommand({
      id: "open-timeline",
      name: "Open Timeline",
      callback: () => void this.activateTimeline(),
    });

    // ---------------------------------------------------------------------------
    // Active file change → detect book, update API base URL
    // ---------------------------------------------------------------------------

    this.registerEvent(
      this.app.workspace.on("file-open", (file) => {
        if (file instanceof TFile) {
          void this.onActiveFileChange(file);
        }
      })
    );

    // Snapshot editor selection whenever the active leaf changes. CM6 preserves
    // state.selection across focus loss, so reading at this moment is reliable.
    // This is the only capture that fires regardless of HOW the user switched
    // leaves (tab click, ribbon, keyboard shortcut, etc.).
    this.registerEvent(
      this.app.workspace.on("active-leaf-change", (newLeaf) => {
        const prev = this.previousLeaf;
        const prevType = prev?.view?.getViewType?.() ?? "null";
        const newType = newLeaf?.view?.getViewType?.() ?? "null";
        let snapshot = "";
        if (prev && prev !== newLeaf && prev.view instanceof MarkdownView) {
          try {
            snapshot = prev.view.editor.getSelection();
            if (snapshot) this.lastEditorSelection = snapshot;
          } catch { /* leaf may be detached — ignore */ }
        }
        console.log(`[NF] leaf-change ${prevType} → ${newType} | snapshot: ${JSON.stringify(snapshot)} | lastEditorSelection: ${JSON.stringify(this.lastEditorSelection)}`);
        this.previousLeaf = newLeaf;
      })
    );

    // ---------------------------------------------------------------------------
    // Auto-import / auto-sync on file save
    // ---------------------------------------------------------------------------

    this.registerAutoImport();

    // Issue 4 fix: always invalidate prompt cache when CLAUDE.md changes,
    // regardless of whether autoImport is enabled.
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (file instanceof TFile && file.name === "CLAUDE.md") {
          invalidatePromptCache();
        }
      })
    );

    // ---------------------------------------------------------------------------
    // Settings tab
    // ---------------------------------------------------------------------------

    this.addSettingTab(new NarrativeSettingTab(this.app, this));

    // ---------------------------------------------------------------------------
    // Cache characters for context menu
    // ---------------------------------------------------------------------------

    void this.reloadCharacterCache();

    // ---------------------------------------------------------------------------
    // Startup re-index: run after workspace is ready so active file is known
    // ---------------------------------------------------------------------------

    this.app.workspace.onLayoutReady(() => {
      void this.startupReindex();
      void this.startupHealthCheck();
    });

  }

  /**
   * Soft probe of the configured LLM endpoint (only when provider="local").
   * Surfaces a Notice if unreachable so the user fixes config before sending a message.
   */
  private async startupHealthCheck(): Promise<void> {
    if (this.settings.provider !== "local") return;
    const err = await pingLocalLLM(this.settings.localBaseUrl);
    if (err) {
      new Notice(
        `Narrative Forge: Local LLM unreachable at ${this.settings.localBaseUrl}. ${err}. ` +
        `Check Settings → LLM Provider, or start your local server.`,
        8000
      );
    }
  }

  async onunload(): Promise<void> {
    this.localServer.stop();

    if (this.settings.backendMode === "managed") {
      await this.backend.stop();
    }

    // Clean up debounce timers
    for (const timer of this.autoImportDebounceMap.values()) {
      clearTimeout(timer);
    }
    this.autoImportDebounceMap.clear();
  }

  // ---------------------------------------------------------------------------
  // Active file → book detection
  // ---------------------------------------------------------------------------

  private async onActiveFileChange(file: TFile): Promise<void> {
    // Only re-detect book from markdown files — ignore panels, attachments, etc.
    if (file.extension !== "md") return;

    // Always track the last focused .md file for chat context
    this.lastActiveMdPath = file.path;

    // Bug 10: don't override currentBookRoot while startup reindex is still running
    if (!this.startupReindexDone) return;

    const result = await this.bookManager.findBook(file.path);
    const sidebar = this.getSidebarView();

    if (result) {
      const prevRoot = this.currentBookRoot;
      this.currentBookRoot = result.bookRoot;
      this.api.setBaseUrl(result.config.backendUrl);
      void this.reloadCharacterCache();
      if (sidebar) void sidebar.refresh();

      // If the user switched to a different book, re-index its Orama DB.
      // reindexInProgress prevents overlapping jobs when files are opened rapidly.
      if (prevRoot !== result.bookRoot && !this.reindexInProgress) {
        const absDir = this.getAbsoluteBookDir();
        if (absDir) {
          this.reindexInProgress = true;
          (async () => {
            try {
              await vectorDb.loadFromFile(this.app, result.bookRoot, this.settings.embeddingModel);
              const pluginData = (await this.loadData()) || {};
              const bookCache: Record<string, FileHashEntry> = pluginData.fileHashes?.[absDir] ?? {};
              const { updated_cache } = await importBookLocally(
                this.app, absDir, false, this.settings.embeddingModel, bookCache
              );
              const currentData = (await this.loadData()) || {};
              await this.saveData({
                ...currentData,
                fileHashes: { ...(currentData.fileHashes || {}), [absDir]: updated_cache }
              });
            } catch (e) {
              console.error("[Narrative Forge] Book switch reindex failed:", e);
            } finally {
              this.reindexInProgress = false;
            }
          })();
        }
      }
    } else {
      // Don't reset currentBookRoot — keep last active book for chat.
      if (sidebar) sidebar.showNoBook();
    }
  }

  /** Returns absolute filesystem path to the current book root, or undefined. */
  getAbsoluteBookDir(): string | undefined {
    const bookRoot = this.currentBookRoot;
    if (bookRoot == null) return undefined;
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return undefined;
    const base = adapter.getBasePath();
    return bookRoot ? `${base}/${bookRoot}` : base;
  }

  private async reloadCharacterCache(): Promise<void> {
    const bookRoot = this.currentBookRoot;
    if (!bookRoot) { this.cachedCharacters = []; return; }
    const files = this.app.vault.getFiles().filter(f =>
      f.path.startsWith(`${bookRoot}/characters/`) &&
      f.extension === 'md' &&
      !f.name.startsWith('_')
    );
    this.cachedCharacters = files.map(f => ({ name: f.basename }));
  }

  private getSidebarView(): import("./sidebar").NarrativeSidebarView | null {
    const leaves = this.app.workspace.getLeavesOfType(NarrativeSidebarView.VIEW_TYPE);
    if (!leaves.length) return null;
    const view = leaves[0].view;
    return view instanceof NarrativeSidebarView ? view : null;
  }

  // ---------------------------------------------------------------------------
  // Create new book
  // ---------------------------------------------------------------------------

  private async createNewBook(): Promise<void> {
    new CreateBookModal(this.app, async (title, folderName) => {
      try {
        const vault = this.app.vault;

        // Create folder structure
        const base = folderName;
        const subfolders = ["chapters", "characters", "locations", "world", "notes"];
        for (const sub of subfolders) {
          const path = normalizePath(`${base}/${sub}`);
          if (!vault.getAbstractFileByPath(path)) {
            await vault.createFolder(path);
          }
        }

        // Create .narrative-book.json marker
        const config: BookConfig = {
          title,
          author: "",
          backendUrl: "http://localhost:8000",
          folders: {
            chapters: "chapters",
            characters: "characters",
            locations: "locations",
            world: "world",
            notes: "notes",
          },
        };
        const markerPath = normalizePath(`${base}/.narrative-book.json`);
        if (!vault.getAbstractFileByPath(markerPath)) {
          await vault.create(markerPath, JSON.stringify(config, null, 2));
        }

        // ── Sample chapter ──────────────────────────────────────────────────
        const sampleChapter = normalizePath(`${base}/chapters/01-chapter.md`);
        if (!vault.getAbstractFileByPath(sampleChapter)) {
          await vault.create(sampleChapter, `---
chapter: 1
title: "Chapter One"
location: "[[Location Name]]"
timeline: "Year 1, Day 1"
characters:
  - "[[Character One]]"
  - "[[Character Two]]"
pov: "[[Character One]]"
status: draft
word_target: 3000
---

Narrative text of the first scene. Describe setting, action, inner thoughts.

[character: Character One] — Dialogue goes here.
[character: Character Two] — Response goes here.

More narrative between the dialogue lines.

---
location:: [[Another Location]]
timeline:: Year 1, Day 1, later

Second scene starts after the scene break. New location and time can be set
with Dataview inline syntax above (location:: and timeline::).

[character: Character One] — A line in the second scene.
`);
        }

        // ── Character template ───────────────────────────────────────────────
        const charTemplate = normalizePath(`${base}/characters/_template.md`);
        if (!vault.getAbstractFileByPath(charTemplate)) {
          await vault.create(charTemplate, `---
type: character
full_name: ""
aliases: []
appears_in: []
role: supporting
status: alive
age:
faction: ""
---

## Description

Physical appearance, voice, mannerisms.

## Background

History before the story starts.

## Arc

How they change over the course of the book.

## Notes

- Private observations, things the reader doesn't know yet
`);
        }

        // ── Location template ────────────────────────────────────────────────
        const locTemplate = normalizePath(`${base}/locations/_template.md`);
        if (!vault.getAbstractFileByPath(locTemplate)) {
          await vault.create(locTemplate, `---
type: location
location_type: city
parent: ""
appears_in: []
climate: ""
population: ""
controlled_by: ""
---

## Description

Atmosphere, sights, sounds, smells.

## Key places

- **Place name** — what happens here

## History

How it came to be this way.
`);
        }

        // ── World element template ───────────────────────────────────────────
        const worldTemplate = normalizePath(`${base}/world/_template.md`);
        if (!vault.getAbstractFileByPath(worldTemplate)) {
          await vault.create(worldTemplate, `---
type: world_element
element_type: magic_system
related_locations: []
---

## Rules

1. First rule
2. Second rule

## Limitations

- What it cannot do
- Cost or drawback
`);
        }

        // ── README ───────────────────────────────────────────────────────────
        const readme = normalizePath(`${base}/README.md`);
        if (!vault.getAbstractFileByPath(readme)) {
          await vault.create(readme, `# ${title}

## Structure

| Folder | Contents |
|--------|----------|
| \`chapters/\` | Story chapters — one file per chapter |
| \`characters/\` | Character profiles — one file per character |
| \`locations/\` | Location notes — one file per location |
| \`world/\` | World-building: magic, factions, history, etc. |

## Chapter format

\`\`\`markdown
---
chapter: 1
title: "Chapter Title"
location: "[[Location Name]]"    ← wikilink → auto-creates location note
timeline: "Year 1, Day 1"
characters:
  - "[[Character Name]]"         ← wikilink → auto-creates character note
pov: "[[Character Name]]"
status: draft                    ← draft / revision / final
word_target: 3000
---

Narrative text here.

[character: Name] — Dialogue line.  ← plugin hides the marker, shows only text

---
location:: [[New Location]]         ← scene break with new location
timeline:: Year 1, later

Second scene narrative.
\`\`\`

## Character format

See \`characters/_template.md\`

## Dataview queries

Install the Dataview plugin to use these:

**All characters:**
\`\`\`dataview
TABLE role, status FROM "${base}/characters"
WHERE type = "character"
SORT file.name ASC
\`\`\`

**Chapter timeline:**
\`\`\`dataview
TABLE timeline, location, status FROM "${base}/chapters"
SORT chapter ASC
\`\`\`

## Backend

This book uses: \`http://localhost:8000\`
Change in \`.narrative-book.json\` if running on a different port.
`);
        }

        // ── Timeline ─────────────────────────────────────────────────────────
        const timelinePath = normalizePath(`${base}/timeline.md`);
        if (!vault.getAbstractFileByPath(timelinePath)) {
          await vault.create(timelinePath, `# Timeline

| title | year | month | day | hour | minute | location | characters | chapter |
|-------|------|-------|-----|------|--------|----------|------------|---------|
`);
        }

        new Notice(`Book "${title}" created in ${folderName}/`);

        // Open the sample chapter
        const chapterFile = vault.getAbstractFileByPath(sampleChapter);
        if (chapterFile instanceof TFile) {
          const leaf = this.app.workspace.getLeaf();
          await leaf.openFile(chapterFile);
        }
      } catch (err) {
        new Notice(`Failed to create book: ${err}`);
        console.error("[Narrative Forge] Create book error:", err);
      }
    }).open();
  }

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  getBackendUrl(): string {
    if (this.settings.backendMode === "external") {
      return (this.settings.externalUrl || "http://localhost:8000").replace(/\/$/, "");
    }
    return "http://localhost:8000";
  }

  async loadSettings(): Promise<void> {
    const data = (await this.loadData()) || {};
    // Strip non-settings keys (fileHashes) so they never pollute this.settings
    // and cannot be accidentally clobbered by saveSettings.
    const { fileHashes: _fh, ...settingsData } = data as any;
    this.settings = Object.assign({}, DEFAULT_SETTINGS, settingsData);
    // Migration: clear modelName if it looks like a cloud model but provider is local
    if (this.settings.provider === "local") {
      const m = this.settings.modelName || "";
      if (m.startsWith("claude") || m.startsWith("gemini") || m.startsWith("gpt")) {
        this.settings.modelName = "";
      }
    }
  }

  async saveSettings(): Promise<void> {
    // Read current persisted data first so fileHashes (written by import jobs)
    // are preserved even if they were updated after the last loadSettings call.
    const current = (await this.loadData()) || {};
    await this.saveData({ ...current, ...this.settings });
  }

  private registerAutoImport(): void {
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!this.settings.autoImport) return;
        if (!(file instanceof TFile)) return;
        if (!file.path.endsWith(".md")) return;

        const existing = this.autoImportDebounceMap.get(file.path);
        if (existing) clearTimeout(existing);

        const timer = setTimeout(async () => {
          this.autoImportDebounceMap.delete(file.path);
          const bookResult = await this.bookManager.findBook(file.path).catch(() => null);
          if (!bookResult) return;

          const { config, bookRoot } = bookResult;
          const chapterFolder = bookRoot
            ? `${bookRoot}/${config.folders.chapters}`
            : config.folders.chapters;
          const isChapterFile = file.path.startsWith(chapterFolder + "/");

          if (isChapterFile) {
            await this.bookManager.syncChapterMetadata(file, bookRoot, config).catch(() => {});
          }

          if (this.settings.provider === "cli") {
            await this.api.importBook(false, this.getAbsoluteBookDir(), this.getEmbeddingLanguage()).catch(() => {});
          }

          // Issue 3: only re-embed chapter files — editing character/location/world
          // files doesn't change vector DB content, so skip the expensive re-index.
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
        }, 2000);

        this.autoImportDebounceMap.set(file.path, timer);
      })
    );
  }

  /**
   * On startup: find the active (first) book in the vault and load/reindex it.
   * Bug 1 fix: only index ONE book — vectorDb is a singleton and can't hold multiple books.
   */
  private async startupReindex(): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return;
    const vaultBase = adapter.getBasePath();

    const bookRoots: string[] = [];

    // Check vault root itself
    if (await adapter.exists(".narrative-book.json")) {
      bookRoots.push("");
    }

    // Check each top-level folder
    try {
      const listing = await adapter.list("/");
      for (const folder of listing.folders) {
        const markerPath = normalizePath(`${folder}/.narrative-book.json`);
        if (await adapter.exists(markerPath)) {
          bookRoots.push(folder);
        }
      }
    } catch { /* ignore */ }

    // Determine which book to index: prefer the one containing the active file,
    // otherwise fall back to the first one found.
    const activeFile = this.app.workspace.getActiveFile();
    let primaryRoot = bookRoots[0] ?? null;
    if (activeFile && bookRoots.length > 1) {
      for (const root of bookRoots) {
        if (root && activeFile.path.startsWith(root + "/")) {
          primaryRoot = root;
          break;
        }
      }
    }

    if (primaryRoot === null) {
      this.startupReindexDone = true;
      return;
    }

    const bookRoot = primaryRoot;
    const markerPath = bookRoot ? `${bookRoot}/.narrative-book.json` : ".narrative-book.json";
    const absBookDir = bookRoot ? `${vaultBase}/${bookRoot}` : vaultBase;

    let backendUrl = "http://localhost:8000";
    try {
      const raw = await adapter.read(markerPath);
      const config = JSON.parse(raw) as Partial<BookConfig>;
      backendUrl = config.backendUrl ?? backendUrl;
    } catch { /* ignore */ }

    this.currentBookRoot = bookRoot;
    this.api.setBaseUrl(backendUrl);

    // Load persisted DB first for immediate search availability
    await vectorDb.loadFromFile(this.app, bookRoot, this.settings.embeddingModel);

    try {
      const pluginData = (await this.loadData()) || {};
      // If the persisted DB had an incompatible schema, wasMigrated is set and we
      // must do a full reindex (empty cache) so no chapters are left un-indexed.
      const bookCache: Record<string, FileHashEntry> = vectorDb.wasMigrated
        ? {}
        : (pluginData.fileHashes?.[absBookDir] ?? {});
      const { updated_cache } = await importBookLocally(
        this.app, absBookDir, false, this.settings.embeddingModel, bookCache
      );
      const currentData = (await this.loadData()) || {};
      await this.saveData({
        ...currentData,
        fileHashes: { ...(currentData.fileHashes || {}), [absBookDir]: updated_cache }
      });
    } catch (e) {
      console.error("Startup reindex failed:", e);
    }

    this.startupReindexDone = true;
  }

  async runImport(force = false): Promise<void> {
    const absDir = this.getAbsoluteBookDir();
    if (!absDir) {
      new Notice("Narrative Forge: No active book.");
      return;
    }
    const notice = new Notice("Narrative Forge: Importing locally...", 0);
    try {
      const pluginData = (await this.loadData()) || {};
      const bookCache: Record<string, FileHashEntry> = force
        ? {}
        : (pluginData.fileHashes?.[absDir] ?? {});
      const result = await importBookLocally(
        this.app, absDir, force, this.settings.embeddingModel, bookCache
      );
      const currentData = (await this.loadData()) || {};
      await this.saveData({
        ...currentData,
        fileHashes: { ...(currentData.fileHashes || {}), [absDir]: result.updated_cache }
      });
      notice.hide();
      new Notice(`Narrative Forge: Imported ${result.chapters_imported} chapter(s) into local vector database.`);
      void this.reloadCharacterCache();
    } catch (err) {
      notice.hide();
      new Notice(`Narrative Forge: Local import failed — ${err}`);
    }
  }

  async testConnection(): Promise<void> {
    const details = await this.api.healthDetails();
    if (details) {
      new Notice(
        `Narrative Forge: Connected. ${details.chapters} chapters, ${details.characters} characters. Provider: ${details.provider}`
      );
    } else {
      new Notice("Narrative Forge: Cannot reach backend. Is it running?");
    }
  }

  async activateSidebar(): Promise<void> {
    const { workspace } = this.app;

    let leaf = workspace.getLeavesOfType(NarrativeSidebarView.VIEW_TYPE)[0];

    if (!leaf) {
      const leftLeaf = workspace.getLeftLeaf(false);
      if (!leftLeaf) return;
      leaf = leftLeaf;
      await leaf.setViewState({
        type: NarrativeSidebarView.VIEW_TYPE,
        active: true,
      });
    }

    workspace.revealLeaf(leaf);
  }

  async activateChat(): Promise<void> {
    const { workspace } = this.app;

    // Capture selection BEFORE revealLeaf shifts focus away from the editor.
    // At this point the markdown editor is still active, so getSelection() is reliable.
    const mdView = workspace.getActiveViewOfType(MarkdownView);
    const preSelection = mdView?.editor.getSelection() ?? "";

    let leaf = workspace.getLeavesOfType(NarrativeChatView.VIEW_TYPE)[0];

    if (!leaf) {
      const rightLeaf = workspace.getRightLeaf(false);
      if (!rightLeaf) return;
      leaf = rightLeaf;
      await leaf.setViewState({
        type: NarrativeChatView.VIEW_TYPE,
        active: true,
      });
    }

    workspace.revealLeaf(leaf);

    if (preSelection && leaf.view instanceof NarrativeChatView) {
      leaf.view.capturedSelection = preSelection;
    }
  }

  async activateTimeline(): Promise<void> {
    const { workspace } = this.app;
    let leaf = workspace.getLeavesOfType(NarrativeTimelineView.VIEW_TYPE)[0];
    if (!leaf) {
      leaf = workspace.getLeaf("tab");
      await leaf.setViewState({
        type: NarrativeTimelineView.VIEW_TYPE,
        active: true,
      });
    }
    workspace.revealLeaf(leaf);
    const view = leaf.view;
    if (view instanceof NarrativeTimelineView) void view.refresh();
  }

  /**
   * Open chat panel and return the NarrativeChatView instance.
   * Used by the "Send to chat" context menu item.
   */
  async activateChatAndGetView(): Promise<NarrativeChatView | null> {
    const { workspace } = this.app;

    let leaf: WorkspaceLeaf | undefined =
      workspace.getLeavesOfType(NarrativeChatView.VIEW_TYPE)[0];

    if (!leaf) {
      const rightLeaf = workspace.getRightLeaf(false);
      if (!rightLeaf) return null;
      leaf = rightLeaf;
      await leaf.setViewState({
        type: NarrativeChatView.VIEW_TYPE,
        active: true,
      });
    }

    workspace.revealLeaf(leaf);

    const view = leaf.view;
    if (view instanceof NarrativeChatView) {
      return view;
    }
    return null;
  }
}
