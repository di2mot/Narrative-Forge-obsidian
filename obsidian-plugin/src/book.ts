/**
 * BookManager — detects books by .narrative-book.json marker,
 * syncs character/location notes from chapter frontmatter.
 */

import { App, TFile, Vault, normalizePath, FileSystemAdapter } from "obsidian";

export interface BookConfig {
  title: string;
  author: string;
  backendUrl: string;
  folders: {
    chapters: string;
    characters: string;
    locations: string;
    world: string;
    notes: string;
  };
}

const BOOK_MARKER = ".narrative-book.json";

export class BookManager {
  constructor(private app: App) {}

  // ---------------------------------------------------------------------------
  // Book detection
  // ---------------------------------------------------------------------------

  /**
   * Walk up from filePath until we find .narrative-book.json.
   * Returns { config, bookRoot } or null if not inside any book.
   */
  private async readMarker(markerPath: string): Promise<BookConfig | null> {
    try {
      // Use adapter.read() — works with dotfiles unlike vault.getAbstractFileByPath()
      const raw = await this.app.vault.adapter.read(markerPath);
      const config = JSON.parse(raw) as Partial<BookConfig>;
      return {
        title: config.title ?? "Untitled",
        author: config.author ?? "",
        backendUrl: config.backendUrl ?? "http://localhost:8000",
        folders: {
          chapters: config.folders?.chapters ?? "chapters",
          characters: config.folders?.characters ?? "characters",
          locations: config.folders?.locations ?? "locations",
          world: config.folders?.world ?? "world",
          notes: config.folders?.notes ?? "notes",
        },
      };
    } catch {
      return null;
    }
  }

  async findBook(
    filePath: string
  ): Promise<{ config: BookConfig; bookRoot: string } | null> {
    const parts = filePath.split("/");
    parts.pop();

    while (parts.length > 0) {
      const dir = parts.join("/");
      const markerPath = normalizePath(`${dir}/${BOOK_MARKER}`);
      if (await this.app.vault.adapter.exists(markerPath)) {
        const config = await this.readMarker(markerPath);
        if (config) return { config, bookRoot: dir };
      }
      parts.pop();
    }

    // Also check vault root
    if (await this.app.vault.adapter.exists(BOOK_MARKER)) {
      const config = await this.readMarker(BOOK_MARKER);
      if (config) return { config, bookRoot: "" };
    }

    return null;
  }

  // ---------------------------------------------------------------------------
  // Chapter metadata sync
  // ---------------------------------------------------------------------------

  /**
   * Parse a chapter file's frontmatter and inline scene metadata,
   * then ensure character/location notes exist and are up to date.
   *
   * One-directional: chapter → character/location notes.
   */
  async syncChapterMetadata(
    file: TFile,
    bookRoot: string,
    config: BookConfig
  ): Promise<void> {
    const content = await this.app.vault.read(file);
    const chapterLink = `[[${file.basename}]]`;

    // --- Parse YAML frontmatter ---
    const frontmatterMatch = /^---\r?\n([\s\S]*?)\r?\n---/.exec(content);

    const characterNames: string[] = [];
    const locationNames: string[] = [];

    if (frontmatterMatch) {
      const yaml = frontmatterMatch[1];

      // Extract characters array:  - "[[Name]]"  or  - [[Name]]
      const charsBlockMatch = /^characters:\s*\r?\n((?:[ \t]+-[^\n]*\n?)*)/m.exec(yaml);
      if (charsBlockMatch) {
        const lines = charsBlockMatch[1].split("\n");
        for (const line of lines) {
          const m = /^\s*-\s*["']?\[\[([^\]]+)\]\]["']?/.exec(line);
          if (m) characterNames.push(m[1].trim());
        }
      }

      // Extract pov: "[[Name]]"
      const povMatch = /^pov:\s*["']?\[\[([^\]]+)\]\]["']?/m.exec(yaml);
      if (povMatch) {
        const name = povMatch[1].trim();
        if (!characterNames.includes(name)) characterNames.push(name);
      }

      // Extract location: "[[Place]]"
      const locMatch = /^location:\s*["']?\[\[([^\]]+)\]\]["']?/m.exec(yaml);
      if (locMatch) locationNames.push(locMatch[1].trim());
    }

    // --- Parse inline scene metadata: location:: [[X]] ---
    const inlineLocRe = /^location::\s*\[\[([^\]]+)\]\]/gm;
    let m: RegExpExecArray | null;
    while ((m = inlineLocRe.exec(content)) !== null) {
      const name = m[1].trim();
      if (!locationNames.includes(name)) locationNames.push(name);
    }

    // Also parse inline characters:: [[X]], [[Y]]
    const inlineCharRe = /^characters?::\s*(.*)/gm;
    while ((m = inlineCharRe.exec(content)) !== null) {
      const raw = m[1];
      const linkRe = /\[\[([^\]]+)\]\]/g;
      let lm: RegExpExecArray | null;
      while ((lm = linkRe.exec(raw)) !== null) {
        const name = lm[1].trim();
        if (!characterNames.includes(name)) characterNames.push(name);
      }
    }

    // --- Ensure notes ---
    const vault = this.app.vault;
    const rootPrefix = bookRoot ? `${bookRoot}/` : "";

    for (const name of characterNames) {
      const notePath = normalizePath(
        `${rootPrefix}${config.folders.characters}/${name}.md`
      );
      await this.ensureNote(vault, notePath, "character", chapterLink);
    }

    for (const name of locationNames) {
      const notePath = normalizePath(
        `${rootPrefix}${config.folders.locations}/${name}.md`
      );
      await this.ensureNote(vault, notePath, "location", chapterLink);
    }
  }

  // ---------------------------------------------------------------------------
  // Private helpers
  // ---------------------------------------------------------------------------

  /** Strip [[ and ]] from a wikilink string. */
  private parseWikilink(s: string): string {
    return s.replace(/^\[\[/, "").replace(/\]\]$/, "").trim();
  }

  /**
   * Ensure a character/location note exists.
   * If it doesn't, create it with default frontmatter.
   * Either way, make sure chapterLink is in appears_in.
   */
  private async ensureNote(
    vault: Vault,
    notePath: string,
    type: "character" | "location",
    chapterLink: string
  ): Promise<void> {
    const existing = vault.getAbstractFileByPath(notePath);

    if (!(existing instanceof TFile)) {
      // Create parent folder if needed
      const folder = notePath.substring(0, notePath.lastIndexOf("/"));
      if (folder && !vault.getAbstractFileByPath(folder)) {
        await vault.createFolder(folder).catch(() => {
          // Folder may already exist, ignore
        });
      }

      // Create new note
      const initialContent = this.buildNoteContent(type, [chapterLink]);
      await vault.create(notePath, initialContent).catch(() => {
        // Race condition: another save may have created it simultaneously
      });
      return;
    }

    // File exists — update appears_in (atomic via vault.process)
    await vault.process(existing, (data) => this.addToAppearsIn(data, chapterLink, type));
  }

  private buildNoteContent(
    type: "character" | "location",
    appearsIn: string[]
  ): string {
    const list = appearsIn.map((l) => `  - "${l}"`).join("\n");
    return `---
type: ${type}
aliases: []
appears_in:
${list}
description: ""
---
`;
  }

  /**
   * Add chapterLink to the appears_in YAML list if not already present.
   * Handles both plain and quoted wikilink formats.
   */
  private addToAppearsIn(
    content: string,
    chapterLink: string,
    type: "character" | "location"
  ): string {
    // Check if chapterLink (or its basename) is already in appears_in
    const basename = chapterLink.replace(/^\[\[/, "").replace(/\]\]$/, "");
    if (
      content.includes(`[[${basename}]]`) ||
      content.includes(`"[[${basename}]]"`)
    ) {
      return content;
    }

    // Try to insert into existing appears_in block
    const appearsInRe = /^(appears_in:\s*\r?\n)((?:[ \t]+-[^\n]*\n?)*)/m;
    const match = appearsInRe.exec(content);
    if (match) {
      const newEntry = `  - "${chapterLink}"\n`;
      return content.replace(
        appearsInRe,
        `$1${match[2]}${newEntry}`
      );
    }

    // appears_in key exists but has no items (e.g., "appears_in: []" or empty)
    const emptyListRe = /^appears_in:\s*(\[\])?\s*$/m;
    if (emptyListRe.test(content)) {
      return content.replace(
        emptyListRe,
        `appears_in:\n  - "${chapterLink}"`
      );
    }

    // No appears_in at all — inject it before the closing --- of frontmatter
    const closingRe = /^(---\r?\n[\s\S]*?)(^---)/m;
    if (closingRe.test(content)) {
      return content.replace(
        closingRe,
        `$1appears_in:\n  - "${chapterLink}"\n$2`
      );
    }

    return content;
  }
}
