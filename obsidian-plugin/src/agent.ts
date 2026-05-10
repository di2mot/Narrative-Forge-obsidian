import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";
import { normalizePath } from "obsidian";
import type { ChatEvent, NarrativeAPI } from "./api";
import { LocalToolExecutor } from "./tools";

let _toolCallSeq = 0;

// ---------------------------------------------------------------------------
// Node fetch — bypasses CORS (app://obsidian.md origin is blocked by local LLM servers)
// ---------------------------------------------------------------------------

// eslint-disable-next-line @typescript-eslint/no-explicit-any
function makeNodeFetch(): typeof fetch {
  return async function nodeFetch(input: RequestInfo | URL, init?: RequestInit): Promise<Response> {
    const urlStr = input.toString();
    const urlObj = new URL(urlStr);
    // eslint-disable-next-line @typescript-eslint/no-require-imports
    const lib: any = urlObj.protocol === "https:" ? require("https") : require("http");

    return new Promise((resolve, reject) => {
      const headers: Record<string, string> = {};
      if (init?.headers) {
        new Headers(init.headers as HeadersInit).forEach((v, k) => { headers[k] = v; });
      }

      // The OpenAI SDK sends body as a JSON string for chat completions. Setting
      // Content-Length explicitly avoids chunked transfer encoding which some
      // local LLM servers (notably LM Studio) reject silently.
      let bodyBuf: Buffer | undefined;
      if (init?.body !== undefined && init?.body !== null) {
        if (typeof init.body === "string") {
          bodyBuf = Buffer.from(init.body, "utf-8");
        } else if (init.body instanceof ArrayBuffer) {
          bodyBuf = Buffer.from(init.body);
        } else if (ArrayBuffer.isView(init.body)) {
          const view = init.body as ArrayBufferView;
          bodyBuf = Buffer.from(view.buffer, view.byteOffset, view.byteLength);
        } else {
          // Fallback: stringify whatever else (FormData/Blob/stream not supported here)
          try { bodyBuf = Buffer.from(JSON.stringify(init.body), "utf-8"); }
          catch { bodyBuf = undefined; }
        }
        if (bodyBuf && !Object.keys(headers).some(k => k.toLowerCase() === "content-length")) {
          headers["content-length"] = String(bodyBuf.length);
        }
      }

      // Node 17+ resolves "localhost" to ::1 (IPv6) first on macOS, but most
      // local LLM servers (LM Studio, Ollama) bind only to 127.0.0.1 (IPv4),
      // causing ECONNREFUSED ::1:<port>. Force IPv4 for loopback hostnames.
      const isLoopback =
        urlObj.hostname === "localhost" ||
        urlObj.hostname === "127.0.0.1" ||
        urlObj.hostname === "::1" ||
        urlObj.hostname === "[::1]";

      const reqOpts: Record<string, unknown> = {
        hostname: urlObj.hostname === "localhost" ? "127.0.0.1" : urlObj.hostname,
        port: urlObj.port || (urlObj.protocol === "https:" ? 443 : 80),
        path: urlObj.pathname + urlObj.search,
        method: (init?.method || "GET").toUpperCase(),
        headers,
      };
      if (isLoopback) reqOpts.family = 4;
      const req = lib.request(reqOpts, (res: any) => {
        const resHeaders = new Headers();
        for (const [k, v] of Object.entries(res.headers as Record<string, string | string[]>)) {
          resHeaders.set(k, Array.isArray(v) ? v.join(", ") : v);
        }
        const stream = new ReadableStream({
          start(controller) {
            res.on("data", (chunk: Buffer) => controller.enqueue(new Uint8Array(chunk)));
            res.on("end", () => controller.close());
            res.on("error", (e: Error) => controller.error(e));
          },
        });
        resolve(new Response(stream, { status: res.statusCode, headers: resHeaders }));
      });
      req.on("error", (e: Error & { code?: string }) => {
        console.error("[NOS nodeFetch] request error:", e.code, e.message, e);
        reject(e);
      });

      // Forward AbortSignal to the underlying request so the SDK's abort/timeout works.
      const sig = (init as any)?.signal as AbortSignal | undefined;
      if (sig) {
        if (sig.aborted) { req.destroy(new Error("AbortError")); return; }
        sig.addEventListener("abort", () => req.destroy(new Error("AbortError")), { once: true });
      }

      if (bodyBuf) req.write(bodyBuf);
      req.end();
    });
  } as typeof fetch;
}

const NODE_FETCH = makeNodeFetch();

/**
 * Ping an OpenAI-compatible endpoint (Ollama, LM Studio, etc) to check reachability.
 * Hits GET <baseURL>/models with a short timeout. Returns null on success, error message otherwise.
 */
export async function pingLocalLLM(baseURL: string, timeoutMs = 2500): Promise<string | null> {
  if (!baseURL) return "Local Base URL is not set.";
  const url = baseURL.replace(/\/+$/, "") + "/models";
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await NODE_FETCH(url, { method: "GET", signal: ctrl.signal });
    if (!res.ok) return `HTTP ${res.status}`;
    return null;
  } catch (e: any) {
    if (e?.code === "ECONNREFUSED") return `Connection refused at ${baseURL}`;
    if (e?.message === "AbortError" || e?.name === "AbortError") return `Timeout after ${timeoutMs}ms`;
    return e?.message || String(e);
  } finally {
    clearTimeout(timer);
  }
}

// ---------------------------------------------------------------------------
// Base Definitions
// ---------------------------------------------------------------------------

export interface BaseAgent {
  chatStream(
    messages: Anthropic.MessageParam[],
    bookDir: string
  ): AsyncGenerator<ChatEvent>;
}

const TOOL_DEFINITIONS: Anthropic.Tool[] = [
  {
    name: "search_semantic",
    description: "Semantic similarity search over all scenes and dialogue in the book. Use this to find scenes related to a concept, emotion, or event.",
    input_schema: {
      type: "object",
      properties: {
        query: { type: "string", description: "Natural language query" },
        n: { type: "integer", description: "Number of results (default 5)" },
      },
      required: ["query"],
    },
  },
  {
    name: "read_scene",
    description: "Read a specific scene with file-relative line numbers. For editing, prefer read_chapter which shows the full file with line numbers — use those coordinates with edit_scene.",
    input_schema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "Chapter filename e.g. '01-siege.md'" },
        scene_index: { type: "integer", description: "Scene index (0-based)" },
      },
      required: ["filename", "scene_index"],
    },
  },
  {
    name: "read_chapter",
    description: "Read the full chapter file with file-relative line numbers. Always call this before edit_scene to obtain the correct line coordinates.",
    input_schema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "Chapter filename e.g. '01-siege.md'" },
      },
      required: ["filename"],
    },
  },
  {
    name: "edit_scene",
    description:
      "Replace a range of text in a chapter file using LSP-style positions. Lines are 1-indexed (matching read_chapter output); chars are 0-indexed. The range is INCLUSIVE of the start position and EXCLUSIVE of the end position. " +
      "RULE OF THUMB: to replace whole lines N through M (inclusive), set start_line=N, start_char=0, end_line=M+1, end_char=0. Setting end_line=M with end_char=0 will leave line M unchanged. " +
      "Examples: replace just line 5 → (5,0)→(6,0). Replace lines 5–10 → (5,0)→(11,0). Edit chars 3–7 of line 5 → (5,3)→(5,7). " +
      "Always call read_chapter first to obtain correct coordinates.",
    input_schema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "Chapter filename e.g. '01-siege.md'" },
        start_line: { type: "integer", description: "Start line (1-indexed, inclusive)." },
        start_char: { type: "integer", description: "Start char on start_line (0-indexed, inclusive)." },
        end_line: { type: "integer", description: "End line (1-indexed). EXCLUSIVE: line end_line is preserved when end_char=0. To include line M in the edit, set end_line=M+1, end_char=0." },
        end_char: { type: "integer", description: "End char on end_line (0-indexed, exclusive)." },
        new_text: { type: "string", description: "Replacement text (may span multiple lines)." },
      },
      required: ["filename", "start_line", "start_char", "end_line", "end_char", "new_text"],
    },
  },
  {
    name: "write_scene",
    description: "Write a new scene or dialogue passage and append it to a chapter file. Automatically formats dialogue lines.",
    input_schema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "Chapter filename to append to" },
        text: { type: "string", description: "The scene text." },
        location: { type: "string", description: "Location for this scene (optional)" },
        timeline: { type: "string", description: "Timeline for this scene (optional)" },
      },
      required: ["filename", "text"],
    },
  },
  {
    name: "append_to_chapter",
    description: "Append raw text verbatim to the end of a chapter file, separated by a scene divider. Use this for notes, comments, or raw content that should not be reformatted.",
    input_schema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "Chapter filename to append to" },
        text: { type: "string", description: "Raw text to append" },
      },
      required: ["filename", "text"],
    },
  },
  {
    name: "get_book_info",
    description: "Get general information about the book (chapter count). Call only when the author explicitly asks about indexing status.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "list_chapters",
    description: "List every chapter file with its number, title, status, and approximate word count. Use this when the author asks 'what chapters do I have?' or to find the right filename for read_chapter.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "list_characters",
    description: "List every character mentioned in the book, ranked by mentions. Includes characters with profile files in characters/ (marked with ', profile'). Auto-detected from `[character: Name]` dialogue tags, frontmatter, and characters/*.md profiles.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "list_locations",
    description: "List every location mentioned in the book, merged from scene `location::` metadata and location profile files in locations/. Profile locations are marked with ', profile'.",
    input_schema: { type: "object", properties: {} },
  },
  {
    name: "search_by_character",
    description: "Find every scene featuring a given character. Also checks characters/ profile files for alias matches and prepends a profile notice when found. Call read_note on the profile file to get the full bio.",
    input_schema: {
      type: "object",
      properties: {
        name: { type: "string", description: "Character name as it appears in `[character: Name]` tags or in character profile aliases." },
        n: { type: "integer", description: "Maximum number of scenes to return (default 20)." },
      },
      required: ["name"],
    },
  },
  {
    name: "search_by_location",
    description: "Find every scene at a given location (case-insensitive substring match against scene `location::` metadata and locations/ profile aliases). Prepends a profile notice when a matching profile is found.",
    input_schema: {
      type: "object",
      properties: {
        location: { type: "string", description: "Location name or partial match." },
        n: { type: "integer", description: "Maximum number of scenes to return (default 20)." },
      },
      required: ["location"],
    },
  },
  {
    name: "read_note",
    description: "Read any note file (character profile, location description, world rules, etc.) by filename. Resolves across characters/, locations/, world/, notes/, and chapters/. Use this to get the full content of a profile after search_by_character or search_by_location mentions one.",
    input_schema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "Filename, e.g. 'Рей Нансен.md' or 'Ганімед.md'" },
      },
      required: ["filename"],
    },
  },
  {
    name: "create_note",
    description: "Create a new note file (character profile, location profile, world note, chapter, etc.) or overwrite an existing one. Provide the full file content including YAML frontmatter. The path is relative to the book folder (e.g., 'characters/Hero.md', 'locations/Ganymede.md', 'world/magic-system.md'). Parent folders are created automatically.",
    input_schema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "Relative path within the book folder, e.g. 'characters/Велтурс.md'" },
        content: { type: "string", description: "Full file content, including YAML frontmatter if applicable." },
      },
      required: ["filename", "content"],
    },
  },
  {
    name: "get_chapter",
    description: "Read the full chapter file matching a given chapter number (from frontmatter `chapter:`). Returned with file-relative line numbers; suitable for editing with edit_scene.",
    input_schema: {
      type: "object",
      properties: {
        chapter_number: { type: "integer", description: "Chapter number from the file's frontmatter." },
      },
      required: ["chapter_number"],
    },
  },
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

// System prompt cache — keyed by bookDir, invalidated when CLAUDE.md changes.
const promptCache = new Map<string, string>();

export function invalidatePromptCache(bookDir?: string) {
  if (bookDir) promptCache.delete(bookDir);
  else promptCache.clear();
}

async function buildSystemPrompt(app: any, bookDir: string): Promise<string> {
  const cached = promptCache.get(bookDir);
  if (cached) return cached;
  const BASE_PROMPT = `You are an expert fiction writing assistant embedded in Obsidian. You help authors write, edit, and maintain narrative consistency across their book.

## Book folder layout
The author's book may contain these subfolders alongside \`chapters/\`:
- \`characters/\` — one \`.md\` file per character with frontmatter \`full_name\`, \`aliases\`, \`role\`, \`status\`, etc.
- \`locations/\` — one \`.md\` file per location with frontmatter \`full_name\`, \`aliases\`, \`location_type\`, etc.
- \`world/\` — world-building notes with frontmatter \`type: world\` and \`topic\`.
- \`notes/\` — general notes.

**Workflow for character/location questions:** call \`list_characters\` or \`list_locations\` first. If an entry is marked ", profile", call \`read_note("<Name>.md")\` to retrieve the canonical profile before answering.

## Available tools
- \`get_book_info\` — returns the number of indexed chapters. Call this if the author asks about indexing status.
- \`list_chapters\` — lists every chapter file with number, title, status, and word count. Use this to discover filenames before \`read_chapter\`.
- \`list_characters\` — lists every character in the book (chapters + characters/ profiles), ranked by mentions. Entries marked ", profile" have a dedicated profile file.
- \`list_locations\` — lists every location in the book (chapters + locations/ profiles). Entries marked ", profile" have a dedicated profile file.
- \`search_semantic\` — semantic similarity search across all scenes. Use this to find relevant context before writing.
- \`search_by_character\` — find every scene featuring a character; also checks characters/ aliases and prepends a profile notice when found.
- \`search_by_location\` — find every scene at a location; also checks locations/ aliases and prepends a profile notice when found.
- \`read_note\` — read any profile or note file by filename (resolves across characters/, locations/, world/, notes/, chapters/). Use this after search_by_character or search_by_location mentions a profile.
- \`create_note\` — create a new file (character profile, location profile, world note, chapter) or overwrite an existing one. Path is relative to the book folder (e.g., \`characters/Hero.md\`). **Use this whenever the author asks you to create a new character, location, or note — do not just print the content.**
- \`get_chapter\` — read a chapter by its frontmatter \`chapter:\` number (returns full content with line numbers).
- \`read_scene\` — reads one scene from a chapter file (with file-relative line numbers).
- \`read_chapter\` — reads the full chapter file with line numbers. Use this before editing.
- \`edit_scene\` — replaces a range of lines in a chapter file (LSP-style, line+char coordinates).
- \`write_scene\` — appends a new scene block to a chapter file.
- \`append_to_chapter\` — appends raw text to a chapter file.

## Editing workflow — follow this exactly
1. Call \`read_chapter\` to see the file with file-relative line numbers (1-indexed).
2. Pick the range to replace. \`edit_scene\` uses LSP positions: lines 1-indexed, chars 0-indexed, end is **exclusive**.
3. **CRITICAL — replacing whole lines N..M (inclusive):** use \`start_line=N, start_char=0, end_line=M+1, end_char=0\`. If you set \`end_line=M\` with \`end_char=0\`, line M is left untouched and you will get a duplicated last line in the file. Add 1 to end_line whenever you want the last line included.
4. Examples:
   - replace just line 5: \`(5,0) → (6,0)\`
   - replace lines 17–28: \`(17,0) → (29,0)\`
   - edit only chars 3–7 of line 5: \`(5,3) → (5,7)\`
5. Call \`edit_scene\` with those coordinates and the replacement text.
6. Report what was changed.

Do NOT use \`read_scene\` as a substitute for \`read_chapter\` before editing — \`read_scene\` line numbers are scene-relative, \`read_chapter\` line numbers are file-relative and match \`edit_scene\` input.

## Writing new content workflow
1. Call \`search_semantic\` to retrieve relevant scenes for context.
2. Write the new content following the dialogue and formatting rules below.
3. Call \`write_scene\` to append it to the correct chapter file.
4. Show the written text to the author.

## Dialogue formatting — always use this exact format
Every line of dialogue MUST follow this pattern:
\`\`\`
[character: Name] — Dialogue text.
\`\`\`
Example:
\`\`\`
[character: Rey] — Where are we?
[character: Freya] — I don't know. But this isn't Ganymede.
\`\`\`
Rules:
- \`character:\` is lowercase and always inside square brackets
- Use an em dash \`—\` (U+2014), never a hyphen \`-\`
- One space before and after the em dash
- Each dialogue line is on its own line
- Narrative prose between dialogue lines has no special formatting

## Editing rules
- Preserve the author's voice and style exactly — do not paraphrase or improve what wasn't asked
- Only change what was explicitly requested
- After any edit or write, show the affected text and confirm what was done in one sentence

## General rules
- Respond in the same language the author is writing in
- NEVER fabricate story content — always use tools to retrieve facts from the book first
- If \`search_semantic\` returns no results, tell the author the content has not been indexed yet and suggest running Import
- Do NOT ask for permission before calling tools — call them immediately
- If the message includes \`[Active file: path/to/file.md]\`, use that filename in tool calls without asking

## Story bible
If a CLAUDE.md file is appended below, it contains the canonical story bible: characters, world rules, lore, and style guide.
Rules from CLAUDE.md override your defaults. Always check CLAUDE.md before inventing character names, locations, or world details.`;

  let parts = [BASE_PROMPT];

  try {
    const claudeMdPath = normalizePath(`${bookDir}/CLAUDE.md`);
    const claudeMdParentPath = normalizePath(`${bookDir}/../CLAUDE.md`);
    const getFileText = async (p: string) => {
      const f = app.vault.getAbstractFileByPath(p);
      if (f) return await app.vault.read(f);
      return null;
    };

    const claudeContent = (await getFileText(claudeMdPath)) || (await getFileText(claudeMdParentPath));
    if (claudeContent) {
      parts.push(`## Story Bible (CLAUDE.md)\n\n${claudeContent.trim()}`);
    }
  } catch (e) {
    console.warn("Failed to read CLAUDE.md:", e);
  }

  const result = parts.join("\n\n---\n\n");
  promptCache.set(bookDir, result);
  return result;
}

const LOCAL_TOOL_NAMES = new Set([
  "read_scene", "read_chapter", "read_note", "create_note", "edit_scene", "write_scene",
  "append_to_chapter", "search_semantic", "get_book_info",
  "list_chapters", "list_characters", "list_locations", "search_by_character",
  "search_by_location", "get_chapter",
]);

async function executeTools(toolUses: Array<{ id: string; name: string; input: any }>, localTools: any, api: any, bookDir: string): Promise<Anthropic.ToolResultBlockParam[]> {
  const toolResultsContent: Anthropic.ToolResultBlockParam[] = [];
  for (const tool of toolUses) {
    let resultStr = "";
    try {
      if (LOCAL_TOOL_NAMES.has(tool.name) && typeof localTools[tool.name] === "function") {
        resultStr = await localTools[tool.name](tool.input);
      } else {
        const res = await fetch(`${api.baseUrl}/api/tools`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ name: tool.name, input: tool.input, book_dir: bookDir })
        });
        if (res.ok) {
          const data = await res.json();
          resultStr = data.result;
        } else {
          resultStr = `Proxy Error: ${res.statusText}`;
        }
      }
    } catch (e) {
      resultStr = `Error executing tool: ${e}`;
    }
    
    toolResultsContent.push({
      type: "tool_result",
      tool_use_id: tool.id,
      content: resultStr
    });
  }
  return toolResultsContent;
}

// ---------------------------------------------------------------------------
// Anthropic Agent
// ---------------------------------------------------------------------------

export class AnthropicAgent implements BaseAgent {
  private anthropic: Anthropic;

  constructor(apiKey: string, private modelName: string, private localTools: LocalToolExecutor, private api: NarrativeAPI, private app: any) {
    this.anthropic = new Anthropic({ apiKey, dangerouslyAllowBrowser: true });
  }

  async *chatStream(messages: Anthropic.MessageParam[], bookDir: string): AsyncGenerator<ChatEvent> {
    const systemPrompt = await buildSystemPrompt(this.app, bookDir);
    let currentMessages = [...messages];
    let turn = 0;

    while (turn < 5) {
      turn++;
      const stream = await this.anthropic.messages.create({
        model: this.modelName || "claude-sonnet-4-6",
        max_tokens: 4096,
        system: systemPrompt,
        messages: currentMessages,
        tools: TOOL_DEFINITIONS,
        stream: true,
      });

      let assistantMessage: Anthropic.MessageParam = { role: "assistant", content: [] };
      let currentToolCall: any = null;
      let toolUses: Array<{ id: string; name: string; input: any }> = [];

      for await (const chunk of stream) {
        if (chunk.type === "content_block_start") {
          if (chunk.content_block.type === "tool_use") {
            currentToolCall = { type: "tool_use", id: chunk.content_block.id, name: chunk.content_block.name, input: "" };
            (assistantMessage.content as any[]).push(currentToolCall);
            yield { type: "tool_use", data: { name: chunk.content_block.name } };
          } else if (chunk.content_block.type === "text") {
            (assistantMessage.content as any[]).push({ type: "text", text: chunk.content_block.text });
            yield { type: "text_delta", data: { text: chunk.content_block.text } };
          }
        } else if (chunk.type === "content_block_delta") {
          if (chunk.delta.type === "text_delta") {
            const block = (assistantMessage.content as any[])[(assistantMessage.content as any[]).length - 1];
            if (block.type === "text") block.text += chunk.delta.text;
            yield { type: "text_delta", data: { text: chunk.delta.text } };
          } else if (chunk.delta.type === "input_json_delta" && currentToolCall) {
            currentToolCall.input += chunk.delta.partial_json;
          }
        } else if (chunk.type === "content_block_stop") {
          if (currentToolCall) {
            try {
              currentToolCall.input = JSON.parse(currentToolCall.input || "{}");
              toolUses.push({ id: currentToolCall.id, name: currentToolCall.name, input: currentToolCall.input });
              yield { type: "tool_use", data: { name: currentToolCall.name, input: currentToolCall.input } };
            } catch {
              // Malformed streaming JSON — remove the partially-built entry from history
              // so it never poisons future turns sent to the API.
              const arr = assistantMessage.content as any[];
              const idx = arr.indexOf(currentToolCall);
              if (idx !== -1) arr.splice(idx, 1);
              console.warn("[Narrative Forge] Dropped malformed tool_use from history:", currentToolCall.name);
            }
            currentToolCall = null;
          }
        }
      }

      currentMessages.push(assistantMessage);
      if (toolUses.length === 0) break;

      const toolResultsContent = await executeTools(toolUses, this.localTools, this.api, bookDir);
      currentMessages.push({ role: "user", content: toolResultsContent });
    }

    yield { type: "done", data: { messages: currentMessages } };
  }
}

// ---------------------------------------------------------------------------
// OpenAI Agent
// ---------------------------------------------------------------------------

function mapAnthropicToOpenAIMessages(messages: Anthropic.MessageParam[], systemPrompt: string): OpenAI.Chat.ChatCompletionMessageParam[] {
  const oaiMsgs: OpenAI.Chat.ChatCompletionMessageParam[] = [{ role: "system", content: systemPrompt }];
  
  for (const m of messages) {
    if (m.role === "user") {
      if (typeof m.content === "string") {
        oaiMsgs.push({ role: "user", content: m.content });
      } else {
        // Find tool results
        const toolResults = m.content.filter((c: any) => c.type === "tool_result");
        const texts = m.content.filter((c: any) => c.type === "text");
        
        if (texts.length > 0) {
          oaiMsgs.push({ role: "user", content: texts.map((t: any) => t.text).join("\n") });
        }
        for (const tr of toolResults as any[]) {
          oaiMsgs.push({
            role: "tool",
            tool_call_id: tr.tool_use_id,
            content: tr.content
          });
        }
      }
    } else if (m.role === "assistant") {
      if (typeof m.content === "string") {
        oaiMsgs.push({ role: "assistant", content: m.content });
      } else {
        const textBlocks = m.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
        const toolUses = m.content.filter((c: any) => c.type === "tool_use");
        
        const msg: any = { role: "assistant" };
        if (textBlocks) msg.content = textBlocks;
        if (toolUses.length > 0) {
          msg.tool_calls = toolUses.map((tu: any) => ({
            id: tu.id,
            type: "function",
            function: {
              name: tu.name,
              arguments: typeof tu.input === "string" ? tu.input : JSON.stringify(tu.input)
            }
          }));
        }
        oaiMsgs.push(msg);
      }
    }
  }
  return oaiMsgs;
}

const OPENAI_TOOLS: OpenAI.Chat.ChatCompletionTool[] = TOOL_DEFINITIONS.map(t => ({
  type: "function",
  function: {
    name: t.name,
    description: t.description,
    parameters: t.input_schema as any
  }
}));

export class OpenAIAgent implements BaseAgent {
  private openai: OpenAI;

  constructor(apiKey: string, private modelName: string, private localTools: LocalToolExecutor, private api: NarrativeAPI, private app: any, baseURL?: string) {
    this.openai = new OpenAI({ apiKey: apiKey || "ollama", dangerouslyAllowBrowser: true, baseURL, fetch: NODE_FETCH, maxRetries: 0 });
  }

  async *chatStream(messages: Anthropic.MessageParam[], bookDir: string): AsyncGenerator<ChatEvent> {
    const systemPrompt = await buildSystemPrompt(this.app, bookDir);
    let turn = 0;

    // We maintain state in Anthropic format for UI consistency, but map to OpenAI format for requests
    let currentMessages = [...messages];

    let totalTextEmitted = 0;
    let totalToolCalls = 0;

    while (turn < 5) {
      turn++;
      const oaiMessages = mapAnthropicToOpenAIMessages(currentMessages, systemPrompt);

      const stream = await this.openai.chat.completions.create({
        model: this.modelName || "gpt-4o",
        messages: oaiMessages,
        tools: OPENAI_TOOLS,
        stream: true,
      });

      let assistantMessage: Anthropic.MessageParam = { role: "assistant", content: [] };
      let toolUsesMap: Record<number, any> = {};
      let textContent = "";

      for await (const chunk of stream) {
        const delta = chunk.choices[0]?.delta;
        if (!delta) continue;

        if (delta.content) {
          textContent += delta.content;
          yield { type: "text_delta", data: { text: delta.content } };
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            if (!toolUsesMap[idx]) {
              toolUsesMap[idx] = { type: "tool_use", id: tc.id || `call_${Math.random().toString(36).substring(2)}`, name: tc.function?.name || "", input: "" };
            }
            if (tc.function?.name) toolUsesMap[idx].name = tc.function.name;
            if (tc.function?.arguments) toolUsesMap[idx].input += tc.function.arguments;
          }
        }
      }

      if (textContent) {
        (assistantMessage.content as any[]).push({ type: "text", text: textContent });
        totalTextEmitted += textContent.length;
      }

      const toolUsesList = Object.values(toolUsesMap);
      for (const tu of toolUsesList) {
        try {
          tu.input = JSON.parse(tu.input || "{}");
          (assistantMessage.content as any[]).push(tu);
          yield { type: "tool_use", data: { name: tu.name, input: tu.input } };
        } catch (e) {
          console.error(`[NOS OpenAIAgent] Failed to parse tool input for ${tu.name}:`, tu.input);
          // If we can't parse it, we don't push it to history to avoid poisoning the next turn
          yield { type: "text_delta", data: { text: `\n[Error: AI generated invalid tool parameters for ${tu.name}. Try a stronger model.]\n` } };
        }
      }
      totalToolCalls += (assistantMessage.content as any[]).filter((c: any) => c.type === "tool_use").length;

      currentMessages.push(assistantMessage);

      if (toolUsesList.length === 0) break;

      const toolResultsContent = await executeTools(toolUsesList, this.localTools, this.api, bookDir);
      currentMessages.push({ role: "user", content: toolResultsContent });
    }

    // Fallback: small open models (Gemma, Llama 3.2 etc.) sometimes stop emitting
    // anything after a few tool calls — no further tool_calls AND no text. The
    // user sees an empty assistant bubble. Detect that and do one final tool-less
    // call to force a text answer based on whatever tool results we already have.
    if (totalTextEmitted === 0 && totalToolCalls > 0) {
      const oaiMessages = mapAnthropicToOpenAIMessages(currentMessages, systemPrompt);
      oaiMessages.push({
        role: "user",
        content:
          "Based on the tool results above, answer the user's original question now. " +
          "Reply directly in the user's language. Do not call any more tools."
      });

      try {
        const finalStream = await this.openai.chat.completions.create({
          model: this.modelName || "gpt-4o",
          messages: oaiMessages,
          stream: true,
        });
        let finalText = "";
        for await (const chunk of finalStream) {
          const delta = chunk.choices[0]?.delta;
          if (delta?.content) {
            finalText += delta.content;
            yield { type: "text_delta", data: { text: delta.content } };
          }
        }
        if (finalText) {
          currentMessages.push({ role: "assistant", content: [{ type: "text", text: finalText }] as any });
        } else {
          const fallback = "I could not generate a response from the tool results. Try asking again, or switch to a stronger model in Settings → LLM Provider.";
          yield { type: "text_delta", data: { text: fallback } };
          currentMessages.push({ role: "assistant", content: [{ type: "text", text: fallback }] as any });
        }
      } catch (e) {
        console.error("[NOS OpenAIAgent] final pass failed:", e);
      }
    }

    yield { type: "done", data: { messages: currentMessages } };
  }
}

// ---------------------------------------------------------------------------
// Gemini Agent
// ---------------------------------------------------------------------------

function mapAnthropicToGeminiMessages(messages: Anthropic.MessageParam[]): any[] {
  // Build id→name map from all assistant tool_use entries so tool results
  // can look up the exact function name without reconstructing it from the id.
  const toolNameById = new Map<string, string>();
  for (const m of messages) {
    if (m.role === "assistant" && Array.isArray(m.content)) {
      for (const c of m.content as any[]) {
        if (c.type === "tool_use") toolNameById.set(c.id, c.name);
      }
    }
  }

  const geminiMsgs: any[] = [];

  for (const m of messages) {
    if (m.role === "user") {
      if (typeof m.content === "string") {
        geminiMsgs.push({ role: "user", parts: [{ text: m.content }] });
      } else {
        const texts = m.content.filter((c: any) => c.type === "text");
        const toolResults = m.content.filter((c: any) => c.type === "tool_result");

        if (texts.length > 0) {
          geminiMsgs.push({ role: "user", parts: [{ text: texts.map((t: any) => t.text).join("\n") }] });
        }

        if (toolResults.length > 0) {
          const funcParts = toolResults.map((tr: any) => {
            const fnName = toolNameById.get(tr.tool_use_id) ?? tr.tool_use_id;
            return {
              functionResponse: {
                name: fnName,
                response: { result: tr.content }
              }
            };
          });
          geminiMsgs.push({ role: "function", parts: funcParts });
        }
      }
    } else if (m.role === "assistant") {
      if (typeof m.content === "string") {
        geminiMsgs.push({ role: "model", parts: [{ text: m.content }] });
      } else {
        const parts: any[] = [];
        const texts = m.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
        const toolUses = m.content.filter((c: any) => c.type === "tool_use");
        
        if (texts) parts.push({ text: texts });
        for (const tu of toolUses as any[]) {
          parts.push({
            functionCall: {
              name: tu.name,
              args: typeof tu.input === "string" ? JSON.parse(tu.input) : tu.input
            }
          });
        }
        if (parts.length > 0) geminiMsgs.push({ role: "model", parts });
      }
    }
  }
  return geminiMsgs;
}

const GEMINI_TOOLS = [{
  functionDeclarations: TOOL_DEFINITIONS.map(t => {
    // Gemini schema requires explicit "type" mapping.
    const props: Record<string, any> = {};
    const schemaProps = (t.input_schema as any).properties || {};
    for (const [k, v] of Object.entries<any>(schemaProps)) {
      props[k] = { type: v.type.toUpperCase(), description: v.description };
    }
    return {
      name: t.name,
      description: t.description,
      parameters: {
        type: "OBJECT",
        properties: props,
        required: (t.input_schema as any).required || []
      }
    };
  })
}];

export class GeminiAgent implements BaseAgent {
  private genAI: GoogleGenerativeAI;

  constructor(apiKey: string, private modelName: string, private localTools: LocalToolExecutor, private api: NarrativeAPI, private app: any) {
    this.genAI = new GoogleGenerativeAI(apiKey);
  }

  async *chatStream(messages: Anthropic.MessageParam[], bookDir: string): AsyncGenerator<ChatEvent> {
    const systemPrompt = await buildSystemPrompt(this.app, bookDir);
    const model = this.genAI.getGenerativeModel({
      model: this.modelName || "gemini-3-flash-preview",
      systemInstruction: { role: "system", parts: [{ text: systemPrompt }] },
      tools: GEMINI_TOOLS as any,
    });

    let currentMessages = [...messages];
    let turn = 0;

    while (turn < 5) {
      turn++;
      const geminiMsgs = mapAnthropicToGeminiMessages(currentMessages);
      
      const chat = model.startChat({ history: geminiMsgs.slice(0, -1) });
      const lastMsg = geminiMsgs[geminiMsgs.length - 1];
      
      const streamResult = await chat.sendMessageStream(lastMsg.parts);

      let assistantMessage: Anthropic.MessageParam = { role: "assistant", content: [] };
      let toolUses: Array<{ id: string; name: string; input: any }> = [];
      let fullText = "";

      for await (const chunk of streamResult.stream) {
        // chunk.text() throws if the chunk has no text (e.g. function-call-only chunks)
        let chunkText = "";
        try { chunkText = chunk.text(); } catch { /* no text in this chunk */ }
        if (chunkText) {
          fullText += chunkText;
          yield { type: "text_delta", data: { text: chunkText } };
        }
        
        const calls = chunk.functionCalls();
        if (calls) {
          for (const call of calls) {
            const tu = {
              type: "tool_use",
              id: `gf:${call.name}:${++_toolCallSeq}`,
              name: call.name,
              input: call.args
            };
            toolUses.push(tu as any);
            // Gemini provides args as a parsed object already
            yield { type: "tool_use", data: { name: call.name, input: call.args } };
          }
        }
      }

      if (fullText) {
        (assistantMessage.content as any[]).push({ type: "text", text: fullText });
      }
      for (const tu of toolUses) {
        (assistantMessage.content as any[]).push(tu);
      }
      currentMessages.push(assistantMessage);

      if (toolUses.length === 0) break;

      const toolResultsContent = await executeTools(toolUses, this.localTools, this.api, bookDir);
      currentMessages.push({ role: "user", content: toolResultsContent });
    }

    yield { type: "done", data: { messages: currentMessages } };
  }
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

export function createAgent(
  provider: string,
  modelName: string,
  apiKey: string,
  localTools: LocalToolExecutor,
  api: NarrativeAPI,
  app: any,
  localBaseUrl?: string
): BaseAgent {
  if (provider === "openai") {
    return new OpenAIAgent(apiKey, modelName, localTools, api, app, localBaseUrl);
  } else if (provider === "local") {
    return new OpenAIAgent("local", modelName || "llama3.1", localTools, api, app, localBaseUrl || "http://localhost:11434/v1");
  } else if (provider === "gemini") {
    return new GeminiAgent(apiKey, modelName, localTools, api, app);
  } else {
    return new AnthropicAgent(apiKey, modelName, localTools, api, app);
  }
}
