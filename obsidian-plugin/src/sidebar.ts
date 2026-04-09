/**
 * Left sidebar leaf — Characters | Chapters | Progress tabs.
 */

import { ItemView, WorkspaceLeaf, TFile } from "obsidian";
import type NarrativePlugin from "./main";

type SidebarTab = "characters" | "chapters" | "progress";

interface CharacterItem {
  name: string;
  description: string;
  role: string;
  status: string;
  appears_in: string[];
}

interface ChapterItem {
  title: string;
  chapter: number;
  status: string;
  timeline: string;
  location: string;
  word_target?: number;
}

export class NarrativeSidebarView extends ItemView {
  static VIEW_TYPE = "narrative-sidebar";

  private plugin: NarrativePlugin;
  private activeTab: SidebarTab = "characters";
  private tabContentEl!: HTMLElement;
  private tabBarEl!: HTMLElement;
  private isLoading = false;

  constructor(leaf: WorkspaceLeaf, plugin: NarrativePlugin) {
    super(leaf);
    this.plugin = plugin;
  }

  getViewType(): string {
    return NarrativeSidebarView.VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Narrative Forge";
  }

  getIcon(): string {
    return "book-open";
  }

  async onOpen(): Promise<void> {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("narrative-sidebar");

    // Header
    const header = root.createEl("div", { cls: "narrative-sidebar-header" });
    header.createEl("span", { text: "Narrative Forge", cls: "narrative-sidebar-title" });

    const refreshBtn = header.createEl("button", {
      cls: "narrative-sidebar-refresh",
      title: "Refresh",
    });
    refreshBtn.innerHTML = "&#8635;";
    refreshBtn.addEventListener("click", () => {
      void this.loadActiveTab();
    });

    // Tab bar
    this.tabBarEl = root.createEl("div", { cls: "narrative-tab-bar" });
    this.renderTabBar();

    // Content area
    this.tabContentEl = root.createEl("div", { cls: "narrative-tab-content" });

    await this.loadActiveTab();
  }

  async onClose(): Promise<void> {
    // Cleanup
  }

  private renderTabBar(): void {
    this.tabBarEl.empty();

    const tabs: Array<{ id: SidebarTab; label: string }> = [
      { id: "characters", label: "Characters" },
      { id: "chapters", label: "Chapters" },
      { id: "progress", label: "Progress" },
    ];

    tabs.forEach(({ id, label }) => {
      const btn = this.tabBarEl.createEl("button", {
        text: label,
        cls: `narrative-tab-btn ${id === this.activeTab ? "active" : ""}`,
      });
      btn.addEventListener("click", () => {
        this.activeTab = id;
        this.renderTabBar();
        void this.loadActiveTab();
      });
    });
  }

  /** Called from main when active book changes — reloads data. */
  async refresh(): Promise<void> {
    await this.loadActiveTab();
  }

  /** Called from main when no book found for active file. */
  showNoBook(): void {
    this.tabContentEl.empty();
    this.tabContentEl.createEl("div", {
      text: "No book found for this file.",
      cls: "narrative-empty",
    });
    this.tabContentEl.createEl("div", {
      text: "Open a file inside a book folder, or create a new book.",
      cls: "narrative-empty-hint",
    });
  }

  async loadActiveTab(): Promise<void> {
    if (this.isLoading) return;
    this.isLoading = true;
    this.showLoading();

    try {
      switch (this.activeTab) {
        case "characters": {
          const chars = await this.loadCharacters();
          this.renderCharacters(chars);
          break;
        }
        case "chapters": {
          const chapters = await this.loadChapters();
          this.renderChapters(chapters);
          break;
        }
        case "progress": {
          const progress = await this.loadProgress();
          this.renderProgress(progress);
          break;
        }
      }
    } catch (err) {
      this.showError(
        err instanceof Error ? err.message : "Failed to load data"
      );
    } finally {
      this.isLoading = false;
    }
  }

  private showLoading(): void {
    this.tabContentEl.empty();
    this.tabContentEl.createEl("div", {
      text: "Loading...",
      cls: "narrative-loading",
    });
  }

  private showError(msg: string): void {
    this.tabContentEl.empty();
    const errDiv = this.tabContentEl.createEl("div", { cls: "narrative-error" });
    errDiv.createEl("div", { text: "Error", cls: "narrative-error-title" });
    errDiv.createEl("div", { text: msg, cls: "narrative-error-msg" });
  }

  // ---------------------------------------------------------------------------
  // Vault readers
  // ---------------------------------------------------------------------------

  private async loadCharacters(): Promise<CharacterItem[]> {
    const bookRoot = this.plugin.getCurrentBookRoot();
    if (!bookRoot) return [];
    const folder = this.plugin.app.vault.getAbstractFileByPath(`${bookRoot}/characters`);
    if (!folder) return [];
    const files = this.plugin.app.vault.getFiles().filter(f =>
      f.path.startsWith(`${bookRoot}/characters/`) &&
      f.extension === 'md' &&
      !f.name.startsWith('_')
    );
    return files.map(f => {
      const fm = this.plugin.app.metadataCache.getFileCache(f)?.frontmatter ?? {};
      return {
        name: f.basename,
        description: fm.description ?? '',
        role: fm.role ?? '',
        status: fm.status ?? '',
        appears_in: fm.appears_in ?? [],
      };
    });
  }

  private async loadChapters(): Promise<ChapterItem[]> {
    const bookRoot = this.plugin.getCurrentBookRoot();
    if (!bookRoot) return [];
    const files = this.plugin.app.vault.getFiles().filter(f =>
      f.path.startsWith(`${bookRoot}/chapters/`) &&
      f.extension === 'md' &&
      !f.name.startsWith('_')
    );
    return files
      .map(f => {
        const fm = this.plugin.app.metadataCache.getFileCache(f)?.frontmatter ?? {};
        return {
          title: fm.title ?? f.basename,
          chapter: fm.chapter ?? 0,
          status: fm.status ?? 'draft',
          timeline: fm.timeline ?? '',
          location: typeof fm.location === 'string' ? fm.location.replace(/\[\[|\]\]/g, '') : '',
          word_target: fm.word_target,
        };
      })
      .sort((a, b) => a.chapter - b.chapter);
  }

  private async loadProgress(): Promise<ChapterItem[]> {
    return this.loadChapters();
  }

  // ---------------------------------------------------------------------------
  // Characters tab
  // ---------------------------------------------------------------------------

  renderCharacters(characters: CharacterItem[]): void {
    this.tabContentEl.empty();

    const bookRoot = this.plugin.getCurrentBookRoot();

    if (characters.length === 0) {
      this.tabContentEl.createEl("div", {
        text: "No characters found. Add markdown files to the characters/ folder.",
        cls: "narrative-empty",
      });
      return;
    }

    const list = this.tabContentEl.createEl("ul", { cls: "narrative-char-list" });

    characters.forEach((char) => {
      const item = list.createEl("li", { cls: "narrative-char-item" });

      // Color dot
      const dot = item.createEl("span", { cls: "narrative-char-dot" });
      dot.style.backgroundColor = this.getCharColor(char.name);

      const info = item.createEl("div", { cls: "narrative-char-info" });
      info.createEl("div", { text: char.name, cls: "narrative-char-name" });

      const badges = info.createEl("div", { cls: "narrative-char-badges" });
      if (char.role) {
        badges.createEl("span", {
          text: char.role,
          cls: "narrative-badge narrative-badge-role",
        });
      }
      if (char.status) {
        const statusCls = char.status === "dead" ? "narrative-badge-dead" : "narrative-badge-alive";
        badges.createEl("span", {
          text: char.status,
          cls: `narrative-badge ${statusCls}`,
        });
      }

      if (char.description) {
        info.createEl("div", {
          text: char.description.slice(0, 80) + (char.description.length > 80 ? "\u2026" : ""),
          cls: "narrative-char-desc",
        });
      }

      item.addEventListener("click", () => {
        if (!bookRoot) return;
        const filePath = `${bookRoot}/characters/${char.name}.md`;
        const file = this.plugin.app.vault.getAbstractFileByPath(filePath);
        if (file instanceof TFile) {
          void this.plugin.app.workspace.getLeaf().openFile(file);
        }
      });
    });
  }

  private getCharColor(name: string): string {
    let hash = 0;
    for (let i = 0; i < name.length; i++) {
      hash = name.charCodeAt(i) + ((hash << 5) - hash);
    }
    const h = Math.abs(hash) % 360;
    return `hsl(${h}, 45%, 45%)`;
  }

  // ---------------------------------------------------------------------------
  // Chapters tab
  // ---------------------------------------------------------------------------

  renderChapters(chapters: ChapterItem[]): void {
    this.tabContentEl.empty();

    const bookRoot = this.plugin.getCurrentBookRoot();

    if (chapters.length === 0) {
      this.tabContentEl.createEl("div", {
        text: "No chapters found. Add markdown files to the chapters/ folder.",
        cls: "narrative-empty",
      });
      return;
    }

    const list = this.tabContentEl.createEl("ul", { cls: "narrative-thread-list" });

    chapters.forEach((ch) => {
      const item = list.createEl("li", { cls: "narrative-thread-item" });

      const topRow = item.createEl("div", { cls: "narrative-thread-top" });
      if (ch.chapter > 0) {
        topRow.createEl("span", {
          text: `Ch. ${ch.chapter}`,
          cls: "narrative-progress-ch",
        });
      }
      topRow.createEl("span", { text: ch.title, cls: "narrative-thread-title" });
      topRow.createEl("span", {
        text: ch.status,
        cls: `narrative-badge narrative-badge-${ch.status.toLowerCase()}`,
      });

      if (ch.timeline || ch.location) {
        const meta = item.createEl("div", { cls: "narrative-char-meta" });
        if (ch.timeline) meta.createEl("span", { text: ch.timeline });
        if (ch.timeline && ch.location) meta.appendText(" · ");
        if (ch.location) meta.createEl("span", { text: ch.location });
      }

      item.addEventListener("click", () => {
        if (!bookRoot) return;
        const files = this.plugin.app.vault.getFiles().filter(f =>
          f.path.startsWith(`${bookRoot}/chapters/`) &&
          f.extension === 'md' &&
          !f.name.startsWith('_')
        );
        const target = files.find(f => {
          const fm = this.plugin.app.metadataCache.getFileCache(f)?.frontmatter ?? {};
          return (fm.chapter ?? 0) === ch.chapter && (fm.title ?? f.basename) === ch.title;
        });
        if (target instanceof TFile) {
          void this.plugin.app.workspace.getLeaf().openFile(target);
        }
      });
    });
  }

  // ---------------------------------------------------------------------------
  // Progress tab
  // ---------------------------------------------------------------------------

  renderProgress(chapters: ChapterItem[]): void {
    this.tabContentEl.empty();

    if (chapters.length === 0) {
      this.tabContentEl.createEl("div", {
        text: "No progress data found.",
        cls: "narrative-empty",
      });
      return;
    }

    // Status summary
    const finalCount = chapters.filter(c => c.status === "final").length;
    const revCount = chapters.filter(c => c.status === "revision").length;
    const summaryDiv = this.tabContentEl.createEl("div", {
      cls: "narrative-progress-summary",
    });
    summaryDiv.createEl("span", { text: `${finalCount}/${chapters.length} final` });
    if (revCount > 0) {
      summaryDiv.createEl("span", { text: `${revCount} in revision` });
    }

    const list = this.tabContentEl.createEl("ul", { cls: "narrative-progress-list" });

    chapters.forEach((ch) => {
      const item = list.createEl("li", { cls: "narrative-progress-item" });

      const topRow = item.createEl("div", { cls: "narrative-progress-top" });
      topRow.createEl("span", {
        text: ch.chapter > 0 ? `Ch. ${ch.chapter}` : ch.title,
        cls: "narrative-progress-ch",
      });
      topRow.createEl("span", { text: ch.title, cls: "narrative-thread-title" });
      topRow.createEl("span", {
        text: ch.status,
        cls: `narrative-badge narrative-badge-${ch.status.toLowerCase()}`,
      });

      // Progress bar using word_target from frontmatter
      if (ch.word_target && ch.word_target > 0) {
        const barWrapper = item.createEl("div", {
          cls: "narrative-progress-bar-wrapper",
        });
        barWrapper.createEl("div", { cls: "narrative-progress-bar" });
        barWrapper.createEl("span", {
          text: `target: ${ch.word_target.toLocaleString()} w`,
          cls: "narrative-progress-pct",
        });
      }
    });
  }

}
