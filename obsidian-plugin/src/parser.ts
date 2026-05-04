import { parseYaml } from "obsidian";

export interface DialogueLine {
  character: string;
  text: string;
}

export interface Scene {
  location: string;
  timeline: string;
  text: string;
  dialogue: DialogueLine[];
  characters: string[];
  line_start: number;
}

export interface Chapter {
  number: number;
  title: string;
  location: string;
  timeline: string;
  characters: string[];
  pov: string;
  status: string;
  word_target: number;
  scenes: Scene[];
  raw_text: string;
  filename: string;
}

const DIALOGUE_RE = /^\[character:\s*([^\]]+)\]\s*[—–-]\s*(.*)/i;
const DATAVIEW_RE = /^(\w+)::\s*(.+)$/;
const WIKILINK_RE = /\[\[([^\]]+)\]\]/g;

export function stripWikilinks(text: string): string {
  return text.replace(WIKILINK_RE, "$1").trim();
}

export function parseWikilinkList(value: unknown): string[] {
  if (!value) return [];
  if (Array.isArray(value)) {
    return value.map((v) => stripWikilinks(String(v)));
  }
  if (typeof value === "string") {
    return [stripWikilinks(value)];
  }
  return [];
}

const FM_RE = /^---\r?\n([\s\S]*?)\n---\r?\n?([\s\S]*)$/;

export function parseChapter(rawText: string, filename: string): Chapter | null {
  let fm: Record<string, any> = {};
  let body = rawText;

  const fmMatch = rawText.match(FM_RE);
  if (fmMatch) {
    try {
      fm = parseYaml(fmMatch[1]) || {};
    } catch (e) {
      fm = { status: "yaml_error" };
      console.warn(`Failed to parse YAML frontmatter in ${filename}:`, e);
    }
    body = fmMatch[2].replace(/^\n/, "");
  }

  const stem = filename.replace(/\.md$/, "");

  const chapter: Chapter = {
    number: Number(fm.chapter) || 0,
    title: String(fm.title || stem),
    location: stripWikilinks(String(fm.location || "")),
    timeline: String(fm.timeline || ""),
    characters: parseWikilinkList(fm.characters),
    pov: stripWikilinks(String(fm.pov || "")),
    status: String(fm.status || "draft"),
    word_target: Number(fm.word_target) || 0,
    scenes: [],
    raw_text: body,
    filename: filename,
  };

  const bodyLines = body.split("\n");
  const rawScenes: Array<{ text: string; start: number }> = [];
  let currentStart = 0;
  let currentBlock: string[] = [];

  for (let lineNo = 0; lineNo < bodyLines.length; lineNo++) {
    const line = bodyLines[lineNo];
    if (/^---\s*$/.test(line)) {
      rawScenes.push({ text: currentBlock.join("\n"), start: currentStart });
      currentBlock = [];
      currentStart = lineNo + 1;
    } else {
      currentBlock.push(line);
    }
  }
  rawScenes.push({ text: currentBlock.join("\n"), start: currentStart });

  let currentLocation = chapter.location;
  let currentTimeline = chapter.timeline;

  for (const rawScene of rawScenes) {
    const rawSceneText = rawScene.text.trim();
    if (!rawSceneText) continue;

    const scene: Scene = {
      location: currentLocation,
      timeline: currentTimeline,
      line_start: rawScene.start,
      text: "",
      dialogue: [],
      characters: [],
    };

    const lines = rawScene.text.split("\n");

    // Extract dataview metadata
    for (let i = 0; i < lines.length; i++) {
      const trimmed = lines[i].trim();
      if (!trimmed) continue; // skip blank lines before/between metadata
      const match = trimmed.match(DATAVIEW_RE);
      if (match) {
        const key = match[1].toLowerCase();
        const val = match[2].trim();
        if (key === "location") {
          scene.location = stripWikilinks(val);
          currentLocation = scene.location;
        } else if (key === "timeline") {
          scene.timeline = stripWikilinks(val);
          currentTimeline = scene.timeline;
        }
      } else {
        break; // first non-blank non-Dataview line ends metadata block
      }
    }

    // Extract dialogue and characters
    for (let j = 0; j < lines.length; j++) {
      const line = lines[j];
      const dm = line.trim().match(DIALOGUE_RE);
      if (dm) {
        const char = dm[1].trim();
        const text = dm[2].trim();
        scene.dialogue.push({ character: char, text });
        if (!scene.characters.includes(char)) {
          scene.characters.push(char);
        }
      }
    }

    // Crucially: save the EXACT raw text so edit_scene string matching works
    scene.text = rawScene.text.trim();
    if (scene.text) {
      chapter.scenes.push(scene);
    }
  }

  return chapter;
}
