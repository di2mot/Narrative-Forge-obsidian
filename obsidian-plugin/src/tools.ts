import { App, TFile, normalizePath, FileSystemAdapter, parseYaml } from "obsidian";
import { parseChapter, parseWikilinkList } from "./parser";
import { vectorDb } from "./database";
import { proposeWrite, PendingEditsRegistry } from "./pending_edits";

export interface ReviewContext {
  reviewAiEdits: boolean;
  pendingEditsRegistry: PendingEditsRegistry;
}

export function addLineNumbers(text: string, startLine: number = 1): string {
  const lines = text.split('\n');
  const lastNum = startLine + lines.length - 1;
  const width = String(lastNum).length;
  return lines
    .map((line, i) => `${String(startLine + i).padStart(width, ' ')}: ${line}`)
    .join('\n');
}

export type LspEditResult = string | { error: string };

/**
 * Convert a (line, char) position into a character offset in `content`.
 * `line` is 1-indexed; `char` is the 0-indexed column within that line.
 * `(line=N, char=0)` is the position immediately BEFORE the first character
 * of line N — so a range ending there leaves line N untouched.
 */
function positionToOffset(content: string, line: number, char: number): number {
  if (line <= 1) return Math.min(char, content.length);
  let offset = 0;
  let currentLine = 1;
  while (currentLine < line && offset < content.length) {
    const nl = content.indexOf("\n", offset);
    if (nl === -1) {
      // line is past the last line — clamp to end of file
      return content.length;
    }
    offset = nl + 1;
    currentLine++;
  }
  // Clamp char to the actual line length so out-of-range chars don't reach into the next line.
  const nextNl = content.indexOf("\n", offset);
  const lineEnd = nextNl === -1 ? content.length : nextNl;
  return Math.min(offset + char, lineEnd);
}

function sliceLspRange(
  content: string,
  startLine: number,
  startChar: number,
  endLine: number,
  endChar: number
): string {
  const from = positionToOffset(content, startLine, startChar);
  const to = positionToOffset(content, endLine, endChar);
  return content.slice(from, to);
}

export function applyLspEdit(
  content: string,
  startLine: number,
  startChar: number,
  endLine: number,
  endChar: number,
  newText: string
): LspEditResult {
  const lineCount = content.split("\n").length;
  // LSP exclusive end: endLine can be lineCount + 1 (meaning "immediately after the last line")
  if (startLine < 1 || startLine > lineCount || endLine < startLine || endLine > (lineCount + 1)) {
    return { error: `Invalid range: file has ${lineCount} lines, requested start=${startLine}, end=${endLine}.` };
  }
  const startOffset = positionToOffset(content, startLine, startChar);
  const endOffset = positionToOffset(content, endLine, endChar);
  if (endOffset < startOffset) {
    return { error: `Invalid range: end position is before start position.` };
  }
  return content.slice(0, startOffset) + newText + content.slice(endOffset);
}

const DIALOGUE_RE = /^\[character:\s*[^\]]+\]\s*[—–-]/;
const COLON_RE = /^(?:\*\*|__)*([А-ЯІЇЄA-Z][^:\*\_]{1,30})(?:\*\*|__)*:\s+(.+)$/;

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

export class LocalToolExecutor {
  private vaultBookDir: string;

  constructor(
    private app: App,
    bookDir: string,
    private reviewContext?: ReviewContext
  ) {
    this.vaultBookDir = toVaultRelative(app, bookDir);
  }

  private getFile(filename: string): TFile | null {
    const d = this.vaultBookDir;
    const searchPaths = [
      d ? `${d}/chapters/${filename}` : `chapters/${filename}`,
      d ? `${d}/characters/${filename}` : `characters/${filename}`,
      d ? `${d}/locations/${filename}` : `locations/${filename}`,
      d ? `${d}/world/${filename}` : `world/${filename}`,
      d ? `${d}/notes/${filename}` : `notes/${filename}`,
      d ? `${d}/${filename}` : filename,
      filename,
    ];

    for (const p of searchPaths) {
      const normalized = normalizePath(p);
      const file = this.app.vault.getAbstractFileByPath(normalized);
      if (file instanceof TFile) return file;
    }
    return null;
  }

  async search_semantic(args: { query: string; n?: number }): Promise<string> {
    const limit = args.n || 5;
    const results = await vectorDb.searchSemantic(args.query, limit);

    if (results.length === 0) {
      return "No matching scenes found. Are you sure the book is indexed?";
    }

    const formatted = results.map((r, i) => {
      const meta = r.metadata as any;
      const chunkInfo = meta.chunk_total > 1 ? ` [chunk ${meta.chunk_index + 1}/${meta.chunk_total}]` : "";
      return `### Result ${i + 1} (Score: ${r.score?.toFixed(3)})${chunkInfo}\n` +
             `- **Chapter**: ${meta.chapter} (${meta.chapter_title})\n` +
             `- **File**: ${meta.filename} (Scene ${meta.scene_index})\n` +
             `- **Location**: ${meta.location || "N/A"}\n` +
             `- **Characters**: ${meta.characters || "None"}\n` +
             `\n${r.text.slice(0, 800)}${r.text.length > 800 ? "..." : ""}\n` +
             `→ To read full scene: read_scene(filename='${meta.filename}', scene_index=${meta.scene_index})`;
    });

    return formatted.join("\n---\n\n");
  }

  // -------- Hybrid lookups --------
  // Each of the next five tools tries the Orama vector DB first (fast and
  // capable of metadata filtering), then falls back to a file-system scan if
  // the DB is empty (no import yet) or throws. This keeps the AI usable on a
  // fresh install before the embedding model has loaded any chapters.

  async list_chapters(_args: unknown): Promise<string> {
    try {
      const chapters = await vectorDb.listChapters();
      if (chapters.length > 0) {
        return `Chapters (${chapters.length}, indexed):\n` +
          chapters.map((c) => `- ${c.filename} — chapter ${c.chapter}: ${c.title}`).join("\n");
      }
    } catch {
      // fall through to file scan
    }
    return await this._listChaptersFromFiles();
  }

  private async _listChaptersFromFiles(): Promise<string> {
    const files = this.getChapterFiles();
    if (files.length === 0) return "No chapters found in chapters/.";
    const rows: string[] = [];
    for (const file of files) {
      const content = await this.app.vault.read(file);
      const chapter = parseChapter(content, file.name);
      const number = chapter?.number ?? 0;
      const title = chapter?.title ?? file.basename;
      const status = chapter?.status ?? "";
      const wordCount = content.replace(/^---[\s\S]*?\n---\n/, "").trim().split(/\s+/).filter(Boolean).length;
      rows.push(`- ${file.name} — chapter ${number}: ${title}${status ? ` (${status})` : ""} — ~${wordCount} words`);
    }
    return `Chapters (${files.length}, file scan):\n${rows.join("\n")}`;
  }

  async list_characters(_args: unknown): Promise<string> {
    try {
      const characters = await vectorDb.listCharacters();
      if (characters.length > 0) {
        return `Characters (${characters.length}, indexed):\n` +
          characters.map((c) => `- ${c}`).join("\n");
      }
    } catch {
      // fall through to file scan
    }
    return await this._listCharactersFromFiles();
  }

  private async _listCharactersFromFiles(): Promise<string> {
    const files = this.getChapterFiles();
    const counts = new Map<string, number>();
    const merge = (name: string) => {
      const trimmed = name.trim();
      if (!trimmed) return;
      counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
    };
    for (const file of files) {
      const content = await this.app.vault.read(file);
      const chapter = parseChapter(content, file.name);
      if (!chapter) continue;
      for (const c of chapter.characters) merge(c);
      for (const scene of chapter.scenes) {
        for (const c of scene.characters) merge(c);
      }
    }

    // Merge character profiles from characters/; track which canonical names have profiles.
    const profileNames = new Set<string>();
    for (const pfile of this.getProfileFiles("characters")) {
      const content = await this.app.vault.read(pfile);
      const fm = this.parseFrontmatter(content);
      const canonical = fm.full_name ? String(fm.full_name).trim() : pfile.basename;
      profileNames.add(canonical.toLowerCase());
      if (!counts.has(canonical)) counts.set(canonical, 0);
      for (const alias of parseWikilinkList(fm.aliases)) {
        if (!counts.has(alias)) counts.set(alias, 0);
      }
    }

    if (counts.size === 0) {
      return "No characters detected. Add `characters: [Name1, Name2]` to a chapter's frontmatter or write `[character: Name] — …` dialogue.";
    }
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    return `Characters (${sorted.length}, file scan):\n` +
      sorted.map(([n, c]) => {
        const profileTag = profileNames.has(n.toLowerCase()) ? ", profile" : "";
        return `- ${n} — ${c} mention${c === 1 ? "" : "s"}${profileTag}`;
      }).join("\n");
  }

  async search_by_character(args: { name: string; n?: number }): Promise<string> {
    if (!args.name?.trim()) return "Provide a character name.";
    const limit = Math.max(1, Math.min(50, args.n ?? 20));
    try {
      const results = await vectorDb.searchByMetadata({ characters: args.name }, limit);
      if (results.length > 0) {
        const formatted = results.map((r) => {
          const meta = r.metadata as any;
          return `[Ch.${meta.chapter} ${meta.filename} scene ${meta.scene_index} — ${meta.location || "—"}]\n${r.text.slice(0, 400)}${r.text.length > 400 ? "…" : ""}`;
        });
        return `Scenes featuring "${args.name}" (${results.length}, indexed):\n` + formatted.join("\n---\n\n");
      }
    } catch {
      // fall through
    }
    return await this._searchByCharacterFromFiles(args.name, limit);
  }

  private async _searchByCharacterFromFiles(name: string, limit: number): Promise<string> {
    const target = name.trim().toLowerCase();

    // Check for a matching profile in characters/
    let profileSection = "";
    for (const pfile of this.getProfileFiles("characters")) {
      const content = await this.app.vault.read(pfile);
      const fm = this.parseFrontmatter(content);
      const canonical = fm.full_name ? String(fm.full_name).trim() : pfile.basename;
      const allNames = [canonical, pfile.basename, ...parseWikilinkList(fm.aliases)].map(s => s.toLowerCase());
      if (allNames.some(n => n.includes(target) || target.includes(n))) {
        profileSection = `Profile: ${pfile.name} (${canonical})\nCall read_note("${pfile.name}") to view the full profile.\n\n`;
        break;
      }
    }

    const files = this.getChapterFiles();
    const hits: string[] = [];
    for (const file of files) {
      if (hits.length >= limit) break;
      const content = await this.app.vault.read(file);
      const chapter = parseChapter(content, file.name);
      if (!chapter) continue;
      for (let i = 0; i < chapter.scenes.length && hits.length < limit; i++) {
        const scene = chapter.scenes[i];
        const matches =
          scene.dialogue.some((d) => d.character.toLowerCase() === target) ||
          scene.characters.some((c) => c.toLowerCase() === target);
        if (matches) {
          const preview = scene.text.replace(/\s+/g, " ").slice(0, 200);
          hits.push(`- ${file.name} scene ${i} (${scene.location || "—"} / ${scene.timeline || "—"}): ${preview}…`);
        }
      }
    }
    if (hits.length === 0 && !profileSection) return `No scenes found featuring "${name}".`;
    const scenesSection = hits.length > 0
      ? `Scenes featuring "${name}" (${hits.length}, file scan):\n${hits.join("\n")}`
      : `No scenes found featuring "${name}" in chapters.`;
    return profileSection ? `${profileSection}${scenesSection}` : scenesSection;
  }

  async search_by_location(args: { location: string; n?: number }): Promise<string> {
    if (!args.location?.trim()) return "Provide a location.";
    const limit = Math.max(1, Math.min(50, args.n ?? 20));
    try {
      const results = await vectorDb.searchByMetadata({ location: args.location }, limit);
      if (results.length > 0) {
        const formatted = results.map((r) => {
          const meta = r.metadata as any;
          return `[Ch.${meta.chapter} ${meta.filename} scene ${meta.scene_index} — ${meta.timeline || "—"}]\n${r.text.slice(0, 400)}${r.text.length > 400 ? "…" : ""}`;
        });
        return `Scenes at "${args.location}" (${results.length}, indexed):\n` + formatted.join("\n---\n\n");
      }
    } catch {
      // fall through
    }
    return await this._searchByLocationFromFiles(args.location, limit);
  }

  private async _searchByLocationFromFiles(location: string, limit: number): Promise<string> {
    const target = location.trim().toLowerCase();

    // Check for a matching profile in locations/
    let profileSection = "";
    for (const pfile of this.getProfileFiles("locations")) {
      const content = await this.app.vault.read(pfile);
      const fm = this.parseFrontmatter(content);
      const canonical = fm.full_name ? String(fm.full_name).trim() : pfile.basename;
      const allNames = [canonical, pfile.basename, ...parseWikilinkList(fm.aliases)].map(s => s.toLowerCase());
      if (allNames.some(n => n.includes(target) || target.includes(n))) {
        profileSection = `Profile: ${pfile.name} (${canonical})\nCall read_note("${pfile.name}") to view the full profile.\n\n`;
        break;
      }
    }

    const files = this.getChapterFiles();
    const hits: string[] = [];
    for (const file of files) {
      if (hits.length >= limit) break;
      const content = await this.app.vault.read(file);
      const chapter = parseChapter(content, file.name);
      if (!chapter) continue;
      for (let i = 0; i < chapter.scenes.length && hits.length < limit; i++) {
        const scene = chapter.scenes[i];
        if (scene.location.toLowerCase().includes(target)) {
          const preview = scene.text.replace(/\s+/g, " ").slice(0, 200);
          hits.push(`- ${file.name} scene ${i} (${scene.location} / ${scene.timeline || "—"}): ${preview}…`);
        }
      }
    }
    if (hits.length === 0 && !profileSection) return `No scenes found at "${location}".`;
    const scenesSection = hits.length > 0
      ? `Scenes at "${location}" (${hits.length}, file scan):\n${hits.join("\n")}`
      : `No scenes found at "${location}" in chapters.`;
    return profileSection ? `${profileSection}${scenesSection}` : scenesSection;
  }

  async list_locations(_args: unknown): Promise<string> {
    return await this._listLocationsFromFiles();
  }

  private async _listLocationsFromFiles(): Promise<string> {
    const counts = new Map<string, number>();
    const merge = (loc: string) => {
      const trimmed = loc.trim();
      if (!trimmed) return;
      counts.set(trimmed, (counts.get(trimmed) ?? 0) + 1);
    };
    for (const file of this.getChapterFiles()) {
      const content = await this.app.vault.read(file);
      const chapter = parseChapter(content, file.name);
      if (!chapter) continue;
      if (chapter.location) merge(chapter.location);
      for (const scene of chapter.scenes) {
        if (scene.location) merge(scene.location);
      }
    }

    // Merge location profiles from locations/
    const profileNames = new Set<string>();
    for (const pfile of this.getProfileFiles("locations")) {
      const content = await this.app.vault.read(pfile);
      const fm = this.parseFrontmatter(content);
      const canonical = fm.full_name ? String(fm.full_name).trim() : pfile.basename;
      profileNames.add(canonical.toLowerCase());
      if (!counts.has(canonical)) counts.set(canonical, 0);
      for (const alias of parseWikilinkList(fm.aliases)) {
        if (!counts.has(alias)) counts.set(alias, 0);
      }
    }

    if (counts.size === 0) {
      return "No locations detected. Add `location:: Place Name` to scene metadata or create files in locations/.";
    }
    const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
    return `Locations (${sorted.length}, file scan):\n` +
      sorted.map(([n, c]) => {
        const profileTag = profileNames.has(n.toLowerCase()) ? ", profile" : "";
        return `- ${n} — ${c} scene${c === 1 ? "" : "s"}${profileTag}`;
      }).join("\n");
  }

  async get_chapter(args: { chapter_number: number }): Promise<string> {
    const target = Number(args.chapter_number);
    if (!Number.isFinite(target)) return "Provide a numeric chapter_number.";
    try {
      const results = await vectorDb.searchByMetadata({ chapter: target }, 50);
      if (results.length > 0) {
        const formatted = results
          .sort((a, b) => (a.metadata as any).scene_index - (b.metadata as any).scene_index)
          .map((r) => {
            const meta = r.metadata as any;
            return `[Scene ${meta.scene_index} — ${meta.location || "—"} — ${meta.timeline || ""}]\n${r.text}`;
          });
        return `[Chapter ${target} — indexed]\n` + formatted.join("\n---\n\n");
      }
    } catch {
      // fall through
    }
    return await this._getChapterFromFiles(target);
  }

  private async _getChapterFromFiles(chapterNumber: number): Promise<string> {
    const files = this.getChapterFiles();
    for (const file of files) {
      const content = await this.app.vault.read(file);
      const chapter = parseChapter(content, file.name);
      if (chapter && chapter.number === chapterNumber) {
        const MAX_CHARS = 8000;
        if (content.length > MAX_CHARS) {
          const cutoff = content.lastIndexOf("\n", MAX_CHARS);
          const truncated = content.slice(0, cutoff > 0 ? cutoff : MAX_CHARS);
          return `[Chapter ${chapterNumber} — ${file.name}]\n${addLineNumbers(truncated)}\n\n[NOTE: truncated; use read_scene with scene_index for specific scenes.]`;
        }
        return `[Chapter ${chapterNumber} — ${file.name}]\n${addLineNumbers(content)}`;
      }
    }
    return `No chapter with number ${chapterNumber} found. Use list_chapters to see available chapters.`;
  }

  async add_timeline_marker(args: {
    filename?: string;
    chapter_number?: number;
    timeline: string;
  }): Promise<string> {
    if (!args.timeline?.trim()) return "Please provide a timeline value (e.g. 'Year 1, Day 15').";
    const timelineVal = args.timeline.trim();

    let file: TFile | null = null;
    let displayLabel = "";

    if (args.chapter_number !== undefined && !isNaN(args.chapter_number)) {
      for (const f of this.getChapterFiles()) {
        const content = await this.app.vault.read(f);
        const fm = this.parseFrontmatter(content);
        if (Number(fm.chapter) === args.chapter_number) {
          file = f;
          displayLabel = fm.title ? `Chapter ${args.chapter_number}: ${fm.title}` : f.basename;
          break;
        }
      }
      if (!file) return `No chapter with number ${args.chapter_number} found.`;
    } else if (args.filename) {
      file = this.getFile(args.filename);
      if (!file) return `File not found: ${args.filename}. Available folders: characters/, locations/, world/, notes/, chapters/`;
      const content = await this.app.vault.read(file);
      const fm = this.parseFrontmatter(content);
      displayLabel = fm.title ? `${fm.title} (${file.basename})` : file.basename;
    } else {
      return "Please provide filename or chapter_number.";
    }

    await this.app.vault.process(file, (data) => {
      if (/^timeline::/m.test(data)) {
        return data.replace(/^timeline::.*$/m, `timeline:: ${timelineVal}`);
      }
      const fmMatch = data.match(/^---\n[\s\S]*?\n---\n/);
      if (fmMatch) {
        const end = fmMatch[0].length;
        return data.slice(0, end) + `timeline:: ${timelineVal}\n` + data.slice(end);
      }
      return `timeline:: ${timelineVal}\n` + data;
    });

    return `Timeline set: **${timelineVal}** on ${file.path} (${displayLabel}).`;
  }

  async list_timeline(_args: unknown): Promise<string> {
    const entries: Array<{ timeline: string; label: string; path: string }> = [];

    for (const f of this.getChapterFiles()) {
      const content = await this.app.vault.read(f);
      const fm = this.parseFrontmatter(content);
      const inlineMatch = content.match(/^timeline::\s*(.+)$/m);
      const timelineVal = inlineMatch
        ? inlineMatch[1].trim()
        : (typeof fm.timeline === "string" ? fm.timeline : undefined);
      if (!timelineVal) continue;
      const label = fm.title
        ? `Chapter ${fm.chapter ?? "?"}: ${fm.title}`
        : f.basename;
      entries.push({ timeline: timelineVal, label, path: f.path });
    }

    if (entries.length === 0) {
      return "No timeline markers found. Use add_timeline_marker to set in-world timestamps on chapters.";
    }

    const lines = entries.map((e) => `- **${e.timeline}** — ${e.label} (\`${e.path}\`)`);
    return `World Timeline (${entries.length} entries, chapter order):\n\n${lines.join("\n")}`;
  }

  async reimport_book(_args: unknown): Promise<string> {
    // Trigger the plugin's existing "Import book" command rather than calling
    // importBookLocally directly — that keeps the cache + saveData logic in
    // one place (main.ts) and avoids cyclic deps.
    const cmd = (this.app as any).commands;
    if (cmd?.executeCommandById) {
      const ok = cmd.executeCommandById("narrative-forge:import-book");
      if (ok) return "Reimport started. Watch the sidebar for progress.";
    }
    return "Could not trigger reimport — please click the Import button in the Narrative Forge sidebar.";
  }

  async get_book_info(_args: any): Promise<string> {
    const d = this.vaultBookDir;
    const chaptersFolder = d ? `${d}/chapters` : "chapters";
    const files = this.app.vault.getFiles().filter(
      f => f.path.startsWith(chaptersFolder + "/") && f.extension === "md"
    );
    return `Book Info:\n- Chapters found: ${files.length}\n- To search content, use \`search_semantic\`.\n- To edit content, use \`edit_scene\` or \`write_scene\`.`;
  }

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

    // scene.line_start is 0-indexed from start of body (after frontmatter).
    // Count frontmatter lines to get file-relative offset.
    const fmMatch = content.match(/^---\n[\s\S]*?\n---\n/);
    const fmLineCount = fmMatch ? fmMatch[0].split('\n').length - 1 : 0;
    const fileLineStart = fmLineCount + scene.line_start + 1;

    return `[Scene ${idx} — ${scene.location} — ${scene.timeline}]\n${addLineNumbers(scene.text, fileLineStart)}`;
  }

  async read_chapter(args: { filename: string }): Promise<string> {
    const file = this.getFile(args.filename);
    if (!file) return `File not found: ${args.filename}. Available folders: chapters/, notes/`;
    const content = await this.app.vault.read(file);
    const MAX_CHARS = 8000;
    if (content.length > MAX_CHARS) {
      const cutoff = content.lastIndexOf("\n", MAX_CHARS);
      const truncated = content.slice(0, cutoff > 0 ? cutoff : MAX_CHARS);
      return addLineNumbers(truncated) +
        `\n\n[NOTE: Content truncated at line boundary (~${MAX_CHARS} chars). Use read_scene with scene_index for specific scenes.]`;
    }
    return addLineNumbers(content);
  }

  async read_note(args: { filename: string }): Promise<string> {
    const file = this.getFile(args.filename);
    if (!file) return `File not found: ${args.filename}. Available folders: characters/, locations/, world/, notes/, chapters/`;
    const content = await this.app.vault.read(file);
    const MAX_CHARS = 8000;
    if (content.length > MAX_CHARS) {
      const cutoff = content.lastIndexOf("\n", MAX_CHARS);
      const truncated = content.slice(0, cutoff > 0 ? cutoff : MAX_CHARS);
      return addLineNumbers(truncated) + `\n\n[NOTE: Content truncated at ~${MAX_CHARS} chars.]`;
    }
    return addLineNumbers(content);
  }

  async create_note(args: { filename: string; content: string }): Promise<string> {
    if (!args.filename) return "Please provide a filename (e.g., characters/Hero.md).";
    if (typeof args.content !== "string") return "Please provide content for the file.";

    const d = this.vaultBookDir;
    const fullPath = normalizePath(d ? `${d}/${args.filename}` : args.filename);

    const existing = this.app.vault.getAbstractFileByPath(fullPath);
    if (existing instanceof TFile) {
      if (this.reviewContext?.reviewAiEdits) {
        const oldText = await this.app.vault.read(existing);
        const lines = oldText.split("\n");
        const status = await proposeWrite(this.app, this.reviewContext.pendingEditsRegistry, {
          filePath: existing.path,
          kind: "replace",
          oldText,
          newText: args.content,
          range: {
            startLine: 1,
            startChar: 0,
            endLine: lines.length,
            endChar: lines[lines.length - 1].length,
          },
        });
        if (status === "rejected") return "User rejected the edit. No change made.";
      }
      await this.app.vault.modify(existing, args.content);
      return `Updated ${args.filename} (${args.content.split("\n").length} lines).`;
    }

    // Ensure parent folders exist before creating the file
    const segments = fullPath.split("/");
    for (let i = 1; i < segments.length - 1; i++) {
      const folderPath = normalizePath(segments.slice(0, i + 1).join("/"));
      if (!this.app.vault.getAbstractFileByPath(folderPath)) {
        await this.app.vault.createFolder(folderPath);
      }
    }

    if (this.reviewContext?.reviewAiEdits) {
      await this.app.vault.create(fullPath, args.content);
      const newFile = this.app.vault.getAbstractFileByPath(fullPath) as TFile;
      const status = await proposeWrite(this.app, this.reviewContext.pendingEditsRegistry, {
        filePath: fullPath,
        kind: "create-file",
        oldText: "",
        newText: args.content,
      });
      if (status === "rejected") {
        await this.app.vault.delete(newFile);
        return "User rejected the new file. File deleted.";
      }
      return `Created ${args.filename} (${args.content.split("\n").length} lines).`;
    }

    await this.app.vault.create(fullPath, args.content);
    return `Created ${args.filename} (${args.content.split("\n").length} lines).`;
  }

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

    if (this.reviewContext?.reviewAiEdits) {
      const content = await this.app.vault.read(file);
      const oldText = sliceLspRange(
        content, args.start_line, args.start_char, args.end_line, args.end_char
      );
      const status = await proposeWrite(this.app, this.reviewContext.pendingEditsRegistry, {
        filePath: file.path,
        kind: "replace",
        oldText,
        newText: args.new_text,
        range: {
          startLine: args.start_line,
          startChar: args.start_char,
          endLine: args.end_line,
          endChar: args.end_char,
        },
      });
      if (status === "rejected") return "User rejected the edit. No change made.";
    }

    let editError: string | null = null;
    let before = 0;
    let after = 0;
    await this.app.vault.process(file, (data) => {
      const r = applyLspEdit(
        data,
        args.start_line, args.start_char,
        args.end_line, args.end_char,
        args.new_text
      );
      if (typeof r === 'object') { editError = r.error; return data; }
      before = data.split("\n").length;
      after = r.split("\n").length;
      return r;
    });
    if (editError) return editError;

    let msg = `Replaced lines ${args.start_line}:${args.start_char}–${args.end_line}:${args.end_char} in ${args.filename} (file: ${before} → ${after} lines).`;

    // Soft-detect the LSP coordinate misuse pattern: model meant for end_line to be the
    // last line replaced (with end_char=0) but LSP semantics preserve that line, and
    // the model also put the same content at the end of new_text. Surface this so the
    // model self-corrects on the next call.
    if (args.end_char === 0 && args.end_line < before) {
      const fileNow = await this.app.vault.read(file);
      const preservedFirstLine = fileNow.split("\n")[args.end_line - 1] ?? "";
      const newLines = args.new_text.split("\n");
      const newTextLast = newLines[newLines.length - 1] ?? "";
      if (preservedFirstLine.length > 4 && newTextLast.trim() === preservedFirstLine.trim()) {
        msg += `\n⚠ Likely duplicate: line ${args.end_line} ("${preservedFirstLine.slice(0, 40)}…") was preserved (LSP exclusive end), and your new_text ends with the same content. To include line ${args.end_line} in the replacement, call again with end_line=${args.end_line + 1}, end_char=0.`;
      }
    }
    return msg;
  }

  async append_to_chapter(args: { filename: string; text: string }): Promise<string> {
    const file = this.getFile(args.filename);
    if (!file) return `File not found: ${args.filename}. Available folders: chapters/, notes/`;

    if (this.reviewContext?.reviewAiEdits) {
      const status = await proposeWrite(this.app, this.reviewContext.pendingEditsRegistry, {
        filePath: file.path,
        kind: "append",
        oldText: "",
        newText: args.text,
      });
      if (status === "rejected") return "User rejected the edit. No change made.";
    }

    await this.app.vault.process(file, (data) => {
      const separator = data.trim() ? "\n\n---\n\n" : "";
      return data + separator + args.text;
    });
    return `Appended to ${args.filename}.`;
  }

  async write_scene(args: { filename: string; text: string; location?: string; timeline?: string }): Promise<string> {
    const file = this.getFile(args.filename);
    if (!file) return `File not found: ${args.filename}. Available folders: chapters/, notes/`;

    const rawText = args.text.trim();
    const location = (args.location || "").trim();
    const timeline = (args.timeline || "").trim();

    const formattedLines: string[] = [];
    for (const line of rawText.split("\n")) {
      const stripped = line.trim();
      if (!stripped) {
        formattedLines.push("");
        continue;
      }
      if (DIALOGUE_RE.test(stripped)) {
        formattedLines.push(stripped);
      } else {
        const m = stripped.match(COLON_RE);
        if (m) {
          formattedLines.push(`[character: ${m[1].trim()}] — ${m[2].trim()}`);
        } else {
          formattedLines.push(stripped);
        }
      }
    }

    const formattedText = formattedLines.join("\n");
    const sceneParts: string[] = [];

    if (location || timeline) {
      const metaLines: string[] = [];
      if (location) metaLines.push(`location:: ${location}`);
      if (timeline) metaLines.push(`timeline:: ${timeline}`);
      sceneParts.push(metaLines.join("\n"));
      sceneParts.push("");
    }
    sceneParts.push(formattedText);
    const sceneBlock = sceneParts.join("\n");

    if (this.reviewContext?.reviewAiEdits) {
      const status = await proposeWrite(this.app, this.reviewContext.pendingEditsRegistry, {
        filePath: file.path,
        kind: "append",
        oldText: "",
        newText: sceneBlock,
      });
      if (status === "rejected") return "User rejected the edit. No change made.";
    }

    await this.app.vault.process(file, (existing) => {
      const separator = existing.trim() ? "\n\n---\n\n" : "";
      return existing + separator + sceneBlock + "\n";
    });

    return `Written to ${args.filename}.\n\nFormatted text:\n${sceneBlock}`;
  }

  /** All chapter `.md` files inside the book's `chapters/` folder, sorted by name. */
  private getChapterFiles(): TFile[] {
    const d = this.vaultBookDir;
    const folder = d ? `${d}/chapters` : "chapters";
    return this.app.vault
      .getFiles()
      .filter((f) => f.path.startsWith(folder + "/") && f.extension === "md")
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** All `.md` files inside `<bookDir>/<subfolder>/`, sorted by name. */
  private getProfileFiles(subfolder: string): TFile[] {
    const d = this.vaultBookDir;
    const folder = d ? `${d}/${subfolder}` : subfolder;
    return this.app.vault
      .getFiles()
      .filter((f) => f.path.startsWith(folder + "/") && f.extension === "md")
      .sort((a, b) => a.name.localeCompare(b.name));
  }

  /** Parse YAML frontmatter from a file's raw content. */
  private parseFrontmatter(content: string): Record<string, unknown> {
    const match = content.match(/^---\n([\s\S]*?)\n---\n/);
    if (!match) return {};
    try {
      return (parseYaml(match[1]) as Record<string, unknown>) || {};
    } catch {
      return {};
    }
  }

}
