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
    return `[Scene ${idx} — ${scene.location} — ${scene.timeline}]\n${scene.text}`;
  }

  async read_chapter(args: { filename: string }): Promise<string> {
    const file = this.getFile(args.filename);
    if (!file) return `File not found: ${args.filename}. Available folders: chapters/, notes/`;
    const content = await this.app.vault.read(file);
    const MAX_CHARS = 8000;
    if (content.length > MAX_CHARS) {
      return content.slice(0, MAX_CHARS) +
        `\n\n[NOTE: Content truncated at ${MAX_CHARS} chars. Use read_scene with scene_index to read specific scenes.]`;
    }
    return content;
  }

  async edit_scene(args: { filename: string; old_text: string; new_text: string }): Promise<string> {
    const file = this.getFile(args.filename);
    if (!file) return `File not found: ${args.filename}. Available folders: chapters/, notes/`;

    const content = await this.app.vault.read(file);
    const count = content.split(args.old_text).length - 1;

    if (count === 0) {
      const normContent = content.split(/\s+/).join(" ");
      const normOld = args.old_text.split(/\s+/).join(" ");
      if (normContent.includes(normOld) && normContent.split(normOld).length - 1 === 1) {
        return "Text not found exactly, but a similar text with different spaces exists. Please use `read_scene` again to copy the exact text, including correct newlines and spaces.";
      }
      return "Text not found in file. Make sure old_text matches exactly (including newlines and spaces).";
    } else if (count > 1) {
      return `Text found ${count} times in the file. Please provide a larger block of text in \`old_text\` to ensure it is unique.`;
    }

    const newContent = content.replace(args.old_text, args.new_text);
    await this.app.vault.modify(file, newContent);
    return `Done. Replaced text in ${args.filename}.`;
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
