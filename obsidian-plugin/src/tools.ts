import { App, TFile, normalizePath, FileSystemAdapter } from "obsidian";
import { parseChapter } from "./parser";
import { vectorDb } from "./database";

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

  constructor(private app: App, bookDir: string) {
    this.vaultBookDir = toVaultRelative(app, bookDir);
  }

  private getFile(filename: string): TFile | null {
    const d = this.vaultBookDir;
    const searchPaths = [
      d ? `${d}/chapters/${filename}` : `chapters/${filename}`,
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
      return `### Result ${i + 1} (Score: ${r.score?.toFixed(3)})\n` +
             `- **Chapter**: ${meta.chapter} (${meta.chapter_title})\n` +
             `- **File**: ${meta.filename} (Scene ${meta.scene_index})\n` +
             `- **Location**: ${meta.location || "N/A"}\n` +
             `- **Characters**: ${meta.characters || "None"}\n` +
             `\n${r.text}\n`;
    });

    return formatted.join("\n---\n\n");
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

  async append_to_chapter(args: { filename: string; text: string }): Promise<string> {
    const file = this.getFile(args.filename);
    if (!file) return `File not found: ${args.filename}. Available folders: chapters/, notes/`;

    const content = await this.app.vault.read(file);
    const separator = content.trim() ? "\n\n---\n\n" : "";
    await this.app.vault.modify(file, content + separator + args.text);
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

    const existing = await this.app.vault.read(file);
    const separator = existing.trim() ? "\n\n---\n\n" : "";
    await this.app.vault.modify(file, existing + separator + sceneBlock + "\n");

    return `Written to ${args.filename}.\n\nFormatted text:\n${sceneBlock}`;
  }
}
