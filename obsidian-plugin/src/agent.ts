import Anthropic from "@anthropic-ai/sdk";
import OpenAI from "openai";
import { GoogleGenerativeAI } from "@google/generative-ai";
import type { ChatEvent, NarrativeAPI } from "./api";
import { LocalToolExecutor } from "./tools";

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
    description: "Edit text in a chapter file using precise line and character positions (LSP-style). Always call read_chapter first to see the file with file-relative line numbers, then specify the exact range to replace. start_char and end_char are 0-indexed within the line; end_char is exclusive.",
    input_schema: {
      type: "object",
      properties: {
        filename: { type: "string", description: "Chapter filename e.g. '01-siege.md'" },
        start_line: { type: "integer", description: "Start line number (1-indexed, inclusive)" },
        start_char: { type: "integer", description: "Start character offset on start_line (0-indexed, inclusive)" },
        end_line: { type: "integer", description: "End line number (1-indexed, inclusive)" },
        end_char: { type: "integer", description: "End character offset on end_line (0-indexed, exclusive)" },
        new_text: { type: "string", description: "Replacement text (may span multiple lines)" },
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
  }
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

## Available tools
- \`get_book_info\` — returns the number of indexed chapters. Call this if the author asks about indexing status.
- \`search_semantic\` — semantic similarity search across all scenes. Use this to find relevant context before writing.
- \`read_scene\` — reads one scene from a chapter file (with file-relative line numbers).
- \`read_chapter\` — reads the full chapter file with line numbers. Use this before editing.
- \`edit_scene\` — replaces a range of lines in a chapter file (LSP-style, line+char coordinates).
- \`write_scene\` — appends a new scene block to a chapter file.
- \`append_to_chapter\` — appends raw text to a chapter file.

## Editing workflow — follow this exactly
1. Call \`read_chapter\` to see the file with line numbers.
2. Identify the range to replace: note \`start_line\`, \`start_char\` (0-indexed), \`end_line\`, \`end_char\` (0-indexed, exclusive).
3. Call \`edit_scene\` with those coordinates and the replacement text.
4. Report what was changed.

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
    const normalizeLocal = (p: string) => p.replace(/^\/+/, "");
    const claudeMdPath = normalizeLocal(`${bookDir}/CLAUDE.md`);
    const claudeMdParentPath = normalizeLocal(`${bookDir}/../CLAUDE.md`);
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
  "read_scene", "read_chapter", "edit_scene", "write_scene",
  "append_to_chapter", "search_semantic", "get_book_info",
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
            currentToolCall.input = JSON.parse(currentToolCall.input || "{}");
            toolUses.push({ id: currentToolCall.id, name: currentToolCall.name, input: currentToolCall.input });
            yield { type: "tool_use", data: { name: currentToolCall.name, input: currentToolCall.input } };
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
    this.openai = new OpenAI({ apiKey: apiKey || "ollama", dangerouslyAllowBrowser: true, baseURL, fetch: globalThis.fetch.bind(globalThis) });
  }

  async *chatStream(messages: Anthropic.MessageParam[], bookDir: string): AsyncGenerator<ChatEvent> {
    const systemPrompt = await buildSystemPrompt(this.app, bookDir);
    let turn = 0;
    
    // We maintain state in Anthropic format for UI consistency, but map to OpenAI format for requests
    let currentMessages = [...messages];

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
              yield { type: "tool_use", data: { name: toolUsesMap[idx].name } };
            }
            if (tc.function?.arguments) {
              toolUsesMap[idx].input += tc.function.arguments;
            }
          }
        }
      }

      if (textContent) {
        (assistantMessage.content as any[]).push({ type: "text", text: textContent });
      }

      const toolUsesList = Object.values(toolUsesMap);
      for (const tu of toolUsesList) {
        tu.input = JSON.parse(tu.input || "{}");
        (assistantMessage.content as any[]).push(tu);
        yield { type: "tool_use", data: { name: tu.name, input: tu.input } };
      }

      currentMessages.push(assistantMessage);

      if (toolUsesList.length === 0) break;

      const toolResultsContent = await executeTools(toolUsesList, this.localTools, this.api, bookDir);
      currentMessages.push({ role: "user", content: toolResultsContent });
    }

    yield { type: "done", data: { messages: currentMessages } };
  }
}

// ---------------------------------------------------------------------------
// Gemini Agent
// ---------------------------------------------------------------------------

function mapAnthropicToGeminiMessages(messages: Anthropic.MessageParam[]): any[] {
  const geminiMsgs: any[] = [];
  
  for (const m of messages) {
    if (m.role === "user") {
      if (typeof m.content === "string") {
        geminiMsgs.push({ role: "user", parts: [{ text: m.content }] });
      } else {
        const parts: any[] = [];
        const texts = m.content.filter((c: any) => c.type === "text");
        const toolResults = m.content.filter((c: any) => c.type === "tool_result");
        
        if (texts.length > 0) {
          geminiMsgs.push({ role: "user", parts: [{ text: texts.map((t: any) => t.text).join("\n") }] });
        }
        
        if (toolResults.length > 0) {
          const funcParts = toolResults.map((tr: any) => {
            const fnName = tr.tool_use_id.startsWith("gf:") 
              ? tr.tool_use_id.split(":")[1] 
              : tr.tool_use_id.replace(/^call_/, "").replace(/_\d+.*$/, "");
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
              id: `gf:${call.name}:${Date.now()}`,
              name: call.name,
              input: call.args
            };
            toolUses.push(tu as any);
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
