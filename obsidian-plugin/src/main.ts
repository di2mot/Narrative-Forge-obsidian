/**
 * Narrative Forge — main Obsidian plugin entry point.
 */

import { Notice, Plugin, WorkspaceLeaf, TFile, Modal, Setting, normalizePath, FileSystemAdapter } from "obsidian";
import { NarrativeAPI } from "./api";
import type { Character } from "./api";
import { BackendManager } from "./backend";
import { buildNosPlugin } from "./decorations";
import { registerContextMenu } from "./context-menu";
import { NarrativeSidebarView } from "./sidebar";
import { NarrativeChatView } from "./chat";
import { NarrativeSettingTab, NarrativeSettings, DEFAULT_SETTINGS } from "./settings";
import { BookManager, BookConfig } from "./book";
import { NarrativeTimelineView } from "./timeline";
import { WritingSession } from "./session";

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
  cachedCharacters: Character[] = [];

  private autoImportDebounceMap = new Map<string, ReturnType<typeof setTimeout>>();
  private writingSession!: WritingSession;
  private currentBookRoot: string | null = null;
  private currentBookLanguage = "uk";
  lastActiveMdPath: string | null = null;  // last focused .md file path (vault-relative)

  getCurrentBookRoot(): string | null {
    return this.currentBookRoot;
  }

  getCurrentBookLanguage(): string {
    return this.currentBookLanguage;
  }

  async onload(): Promise<void> {
    console.log("[Narrative Forge] Loading plugin...");

    await this.loadSettings();

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

    // ---------------------------------------------------------------------------
    // Auto-import / auto-sync on file save
    // ---------------------------------------------------------------------------

    if (this.settings.autoImport) {
      this.registerAutoImport();
    }

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
    });

    console.log("[Narrative Forge] Plugin loaded.");
  }

  async onunload(): Promise<void> {
    console.log("[Narrative Forge] Unloading plugin...");

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

    const result = await this.bookManager.findBook(file.path);
    const sidebar = this.getSidebarView();

    if (result) {
      this.currentBookRoot = result.bookRoot;
      this.currentBookLanguage = (result.config as unknown as Record<string, string>)["language"] ?? "uk";
      this.api.setBaseUrl(result.config.backendUrl);
      void this.reloadCharacterCache();
      if (sidebar) void sidebar.refresh();
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
    this.settings = Object.assign({}, DEFAULT_SETTINGS, await this.loadData());
  }

  async saveSettings(): Promise<void> {
    await this.saveData(this.settings);
  }

  private registerAutoImport(): void {
    this.registerEvent(
      this.app.vault.on("modify", (file) => {
        if (!(file instanceof TFile)) return;
        if (!file.path.endsWith(".md") && !file.path.endsWith(".nos")) return;
        // Skip character/location/world notes — they don't need re-indexing
        if (file.path.includes("/characters/") || file.path.includes("/locations/") || file.path.includes("/world/")) return;

        // Debounce: wait 2s after last modification before importing
        const existing = this.autoImportDebounceMap.get(file.path);
        if (existing) clearTimeout(existing);

        const timer = setTimeout(async () => {
          this.autoImportDebounceMap.delete(file.path);
          try {
            if (file.path.endsWith(".md")) {
              // Sync chapter metadata (character/location notes)
              const bookResult = await this.bookManager.findBook(file.path);
              if (bookResult) {
                const { config, bookRoot } = bookResult;
                // Only sync files inside the chapters folder
                const chapterFolder = bookRoot
                  ? `${bookRoot}/${config.folders.chapters}`
                  : config.folders.chapters;
                if (file.path.startsWith(chapterFolder)) {
                  await this.bookManager.syncChapterMetadata(file, bookRoot, config);
                }
              }
              // Also trigger full import
              await this.api.importBook(false, this.getAbsoluteBookDir(), this.currentBookLanguage).catch(() => {
                // Silent fail — backend may not be running
              });
            } else if (file.path.endsWith(".nos")) {
              await this.api.importBook(false, this.getAbsoluteBookDir(), this.currentBookLanguage).catch(() => {
                // Silent fail — backend may not be running
              });
            }
          } catch {
            // Silent fail — user may not have backend running
          }
        }, 2000);

        this.autoImportDebounceMap.set(file.path, timer);
      })
    );
  }

  /**
   * On startup: find all books in the vault and trigger incremental import
   * for each one (hash-based, so unchanged files are skipped quickly).
   */
  private async startupReindex(): Promise<void> {
    const adapter = this.app.vault.adapter;
    if (!(adapter instanceof FileSystemAdapter)) return;
    const vaultBase = adapter.getBasePath();

    // vault.getFiles() and getAllLoadedFiles() skip dotfiles.
    // Use adapter.list() to find .narrative-book.json in each top-level folder.
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

    for (const bookRoot of bookRoots) {
      const markerPath = bookRoot ? `${bookRoot}/.narrative-book.json` : ".narrative-book.json";
      const absBookDir = bookRoot ? `${vaultBase}/${bookRoot}` : vaultBase;

      let backendUrl = "http://localhost:8000";
      try {
        const raw = await adapter.read(markerPath);
        const config = JSON.parse(raw) as Partial<BookConfig>;
        backendUrl = config.backendUrl ?? backendUrl;
      } catch { /* ignore */ }

      // Set currentBookRoot to the first book found
      if (this.currentBookRoot == null) {
        this.currentBookRoot = bookRoot;
        try {
          const markerRaw = await adapter.read(markerPath).catch(() => "{}");
          this.currentBookLanguage = (JSON.parse(markerRaw) as Record<string, string>)["language"] ?? "uk";
        } catch {
          this.currentBookLanguage = "uk";
        }
        this.api.setBaseUrl(backendUrl);
        console.log(`[Narrative Forge] Active book: ${absBookDir}`);
      }

      try {
        const api = new NarrativeAPI(backendUrl);
        await api.importBook(false, absBookDir, this.currentBookLanguage);
        console.log(`[Narrative Forge] Startup reindex done: ${bookRoot || "vault root"}`);
      } catch {
        // Silent — backend may not be running yet
      }
    }
  }

  async runImport(force = false): Promise<void> {
    const notice = new Notice("Narrative Forge: Importing...", 0);
    try {
      const result = await this.api.importBook(force, this.getAbsoluteBookDir(), this.currentBookLanguage);
      notice.hide();
      new Notice(
        `Narrative Forge: Imported ${result.chapters_imported} chapter(s), ` +
        `${result.characters_found} character(s).` +
        (result.errors.length > 0 ? ` ${result.errors.length} error(s).` : "")
      );
      // Refresh character cache
      void this.reloadCharacterCache();
    } catch (err) {
      notice.hide();
      new Notice(`Narrative Forge: Import failed — ${err}`);
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
