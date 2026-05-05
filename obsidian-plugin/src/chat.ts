/**
 * Chat panel — right sidebar leaf with SSE streaming to /api/chat.
 */

import { ItemView, WorkspaceLeaf, MarkdownRenderer, MarkdownView, Notice, Component, FileSystemAdapter } from "obsidian";
import type { NarrativeAPI, ChatEvent } from "./api";
import type NarrativePlugin from "./main";
import { createAgent } from "./agent";
import { LocalToolExecutor } from "./tools";

interface ChatMessage {
  role: "user" | "assistant";
  content: string;
  toolUses?: Array<{ name: string; input: Record<string, unknown> }>;
}

export class NarrativeChatView extends ItemView {
  static VIEW_TYPE = "narrative-chat";

  private api: NarrativeAPI;
  private plugin: NarrativePlugin;
  private messages: ChatMessage[] = [];
  // Full Anthropic.MessageParam[] history including tool use/result blocks.
  // Maintained separately from display messages for correct multi-turn context.
  private apiHistory: any[] = [];
  private messagesEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private isStreaming = false;
  private mdComponent: Component;
  capturedSelection: string | null = null;

  constructor(leaf: WorkspaceLeaf, api: NarrativeAPI, plugin: NarrativePlugin) {
    super(leaf);
    this.api = api;
    this.plugin = plugin;
    this.mdComponent = new Component();
  }

  getViewType(): string {
    return NarrativeChatView.VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Narrative Chat";
  }

  getIcon(): string {
    return "message-circle";
  }

  /**
   * Find the most recently active MarkdownView. Falls back across leaves so
   * we can still get the editor selection when the chat panel itself is the
   * active leaf (in which case getActiveViewOfType returns null).
   */
  private findActiveMarkdownView(): MarkdownView | null {
    const direct = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    if (direct) return direct;

    const leaves = this.plugin.app.workspace.getLeavesOfType("markdown");
    const lastPath = this.plugin.lastActiveMdPath;
    if (lastPath) {
      for (const leaf of leaves) {
        const v = leaf.view as MarkdownView;
        if (v?.file?.path === lastPath) return v;
      }
    }
    return leaves.length > 0 ? (leaves[0].view as MarkdownView) : null;
  }

  /** Snapshot the current editor selection into capturedSelection (no-op if empty). */
  private captureCurrentSelection(): void {
    const view = this.findActiveMarkdownView();
    const sel = view?.editor.getSelection() ?? "";
    if (sel) this.capturedSelection = sel;
  }

  async onOpen(): Promise<void> {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("narrative-chat");
    this.mdComponent.load();

    // Capture the editor selection BEFORE the click steals focus from the editor.
    // mousedown on the panel fires before focus moves; this guarantees we see
    // the selection even when the user clicks straight into the chat input.
    root.addEventListener("mousedown", () => this.captureCurrentSelection(), true);

    // Header
    const header = root.createEl("div", { cls: "narrative-chat-header" });
    header.createEl("span", { text: "Narrative Chat", cls: "narrative-chat-title" });

    const clearBtn = header.createEl("button", {
      cls: "narrative-chat-clear",
      title: "Clear conversation",
    });
    clearBtn.textContent = "✕";
    clearBtn.addEventListener("click", () => this.clearChat());

    // Messages area
    this.messagesEl = root.createEl("div", { cls: "narrative-chat-messages" });

    // Show welcome message
    this.appendSystemMessage(
      "Ask anything about your story. The AI uses tools to read files when needed."
    );

    // Input area
    const inputArea = root.createEl("div", { cls: "narrative-chat-input-area" });

    this.inputEl = inputArea.createEl("textarea", {
      cls: "narrative-chat-input",
      attr: { placeholder: "Ask about characters, consistency, plot..." },
    }) as HTMLTextAreaElement;

    this.inputEl.addEventListener("keydown", (e) => {
      if (e.key === "Enter" && !e.shiftKey) {
        e.preventDefault();
        void this.handleSend();
      }
    });

    const btnRow = inputArea.createEl("div", { cls: "narrative-chat-btn-row" });

    this.sendBtn = btnRow.createEl("button", {
      text: "Send",
      cls: "narrative-chat-send narrative-btn-primary",
    }) as HTMLButtonElement;
    this.sendBtn.addEventListener("click", () => void this.handleSend());

    // Context indicator
    const ctxIndicator = btnRow.createEl("span", {
      cls: "narrative-chat-context-info",
    });
    ctxIndicator.textContent = "Uses tools to read files";
  }

  async onClose(): Promise<void> {
    this.mdComponent.unload();
  }

  // ---------------------------------------------------------------------------
  // Chat logic
  // ---------------------------------------------------------------------------

  private clearChat(): void {
    this.messages = [];
    this.apiHistory = [];
    this.messagesEl.empty();
    this.appendSystemMessage(
      "Conversation cleared. Ask anything about your story."
    );
  }

  private getContext(): {
    fileContent: string;
    selection: string;
    fileName: string;
    filePath: string;
  } {
    const vaultPath = (this.plugin.app.vault.adapter instanceof FileSystemAdapter)
      ? this.plugin.app.vault.adapter.getBasePath()
      : "";

    // Find the most recent markdown view — works even when the chat panel is the active leaf
    const view = this.findActiveMarkdownView();
    const relativePath = view?.file?.path ?? this.plugin.lastActiveMdPath ?? "";
    const filePath = vaultPath && relativePath ? `${vaultPath}/${relativePath}` : relativePath;

    const selection = this.capturedSelection ?? view?.editor.getSelection() ?? "";
    this.capturedSelection = null;
    return {
      fileContent: view?.editor.getValue() ?? "",
      selection,
      fileName: relativePath.split("/").pop() ?? "",
      filePath,
    };
  }

  /**
   * Pre-fill the chat input with text and send immediately.
   * Called by "Send to chat" context menu item.
   */
  injectMessage(text: string): void {
    if (!this.inputEl) return;
    this.inputEl.value = text;
    void this.handleSend();
  }

  async sendMessage(text: string): Promise<void> {
    if (!text.trim() || this.isStreaming) return;

    // Store plain text in history (for display and multi-turn context)
    this.messages.push({ role: "user", content: text });
    this.appendUserMessage(text);

    // Stream response
    this.isStreaming = true;
    this.sendBtn.disabled = true;
    this.sendBtn.textContent = "...";

    const assistantEl = this.appendAssistantMessage("");
    let fullText = "";
    const toolUses: Array<{ name: string; input: Record<string, unknown> }> = [];

    try {
      const provider = this.plugin.settings.provider;
      const apiKey = provider === "openai" ? this.plugin.settings.openaiApiKey : 
                     provider === "gemini" ? this.plugin.settings.geminiApiKey : 
                     this.plugin.settings.apiKey; // Default to anthropic
                     
      const modelName = this.plugin.settings.modelName;

      // Build API messages: enrich the last user message with active file context
      const { messages: apiMessages, bookDir } = await this.buildApiMessages();
      const language = this.plugin.getEmbeddingLanguage();

      if (provider === "cli") {
        for await (const event of this.api.chatStream(
          apiMessages,
          provider,
          apiKey,
          bookDir,
          language
        )) {
          this.handleChatEvent(event, assistantEl, (text) => {
            fullText += text;
            this.updateAssistantMessage(assistantEl, fullText);
          }, toolUses);
        }
      } else {
        if (!apiKey && provider !== "local") {
           throw new Error(`API key is required for provider '${provider}'. Please set it in Narrative Forge settings.`);
        }
        const localTools = new LocalToolExecutor(this.plugin.app, bookDir || "");
        const agent = createAgent(
          provider, 
          modelName, 
          apiKey, 
          localTools, 
          this.api, 
          this.plugin.app, 
          this.plugin.settings.localBaseUrl
        );

        // Issue 1 fix: always append the new enriched user message to apiHistory
        // so the agent sees both the old conversation AND the current message.
        const lastUserMsg = apiMessages[apiMessages.length - 1];
        if (lastUserMsg?.role === "user") {
          if (this.apiHistory.length > 0) {
            // History exists — append just the new message to it
            this.apiHistory.push({ role: "user", content: lastUserMsg.content });
          } else {
            // First message — bootstrap apiHistory from apiMessages
            this.apiHistory = [...(apiMessages as any[])];
          }
        }

        for await (const event of agent.chatStream(
          this.apiHistory as any,
          bookDir || ""
        )) {
          if (event.type === "done" && event.data.messages) {
            this.apiHistory = event.data.messages as any[];
          }
          this.handleChatEvent(event, assistantEl, (text) => {
            fullText += text;
            // Use plain textContent during streaming to avoid O(n²) markdown re-renders.
            // Final markdown render happens after the loop ends.
            const content = assistantEl.querySelector(".narrative-msg-content") as HTMLElement | null;
            if (content) content.textContent = fullText;
            this.scrollToBottom();
          }, toolUses);
        }
        // Render full markdown once streaming is complete
        this.updateAssistantMessage(assistantEl, fullText);
      }

      this.messages.push({
        role: "assistant",
        content: fullText,
        toolUses: toolUses.length > 0 ? toolUses : undefined,
      });

      // Trim apiHistory to 40 messages (20 turns) to stay within model context limits.
      const MAX_HISTORY = 40;
      if (this.apiHistory.length > MAX_HISTORY) {
        this.apiHistory = this.apiHistory.slice(this.apiHistory.length - MAX_HISTORY);
        new Notice("Narrative Forge: Conversation trimmed to last 20 turns to fit context window.");
      }

      if (toolUses.length > 0) {
        this.appendToolSummary(assistantEl, toolUses);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      let errorMessage = `Error: ${errMsg}`;
      if (this.plugin.settings.provider === "cli") {
        errorMessage += `\n\nIs the Python backend running at ${this.plugin.getBackendUrl()}?`;
      } else if (this.plugin.settings.provider === "local") {
        errorMessage += `\n\nIs your local LLM server running at ${this.plugin.settings.localBaseUrl}?`;
      }

      // If the failure is a connection refusal, list providers that have keys
      // configured as a quick fallback hint (decoupled — no auto-switching).
      if (/ECONNREFUSED|fetch failed|connect ECONNREFUSED/i.test(errMsg)) {
        const alternatives: string[] = [];
        if (this.plugin.settings.apiKey) alternatives.push("Anthropic");
        if (this.plugin.settings.openaiApiKey) alternatives.push("OpenAI");
        if (this.plugin.settings.geminiApiKey) alternatives.push("Gemini");
        if (alternatives.length > 0) {
          errorMessage += `\n\nAlternative providers with keys configured: ${alternatives.join(", ")}. Switch in Settings → LLM Provider.`;
        }
      }

      this.updateAssistantMessage(assistantEl, errorMessage);
      new Notice(`Chat error: ${errMsg}`);
    } finally {
      this.isStreaming = false;
      // Hide streaming cursor
      const indicator = assistantEl.querySelector(".narrative-stream-indicator") as HTMLElement | null;
      if (indicator) indicator.style.display = "none";
      this.sendBtn.disabled = false;
      this.sendBtn.textContent = "Send";
      this.scrollToBottom();
    }
  }

  /**
   * Build messages for the API — identical to this.messages except the last
   * user message is enriched with the active file path and selection.
   * Also returns the absolute book root directory.
   */
  private async buildApiMessages(): Promise<{
    messages: Array<{ role: string; content: string }>;
    bookDir: string | undefined;
  }> {
    const msgs = this.messages.map(m => ({ role: m.role, content: m.content }));

    const vaultBase = (this.plugin.app.vault.adapter instanceof FileSystemAdapter)
      ? this.plugin.app.vault.adapter.getBasePath()
      : "";

    // Try currentBookRoot first; if not set, detect from active file
    let bookRoot = this.plugin.getCurrentBookRoot();
    if (bookRoot == null) {
      const activeFile = this.plugin.app.workspace.getActiveFile();
      if (activeFile?.extension === "md") {
        const result = await this.plugin.bookManager.findBook(activeFile.path);
        if (result) bookRoot = result.bookRoot;
      }
    }

    const bookDir = vaultBase && bookRoot != null
      ? (bookRoot ? `${vaultBase}/${bookRoot}` : vaultBase)
      : undefined;

    if (msgs.length === 0) return { messages: msgs, bookDir };

    const last = msgs[msgs.length - 1];
    if (last.role !== "user") return { messages: msgs, bookDir };

    const ctx = this.getContext();
    if (ctx.filePath || ctx.fileName) {
      const parts: string[] = [];
      parts.push(`[Active file: ${ctx.filePath || ctx.fileName}]`);
      if (ctx.selection) {
        parts.push(`[Selected text]:\n${ctx.selection}`);
      }
      parts.push(last.content);
      msgs[msgs.length - 1] = { role: "user", content: parts.join("\n") };
    }

    return { messages: msgs, bookDir };
  }

  private handleChatEvent(
    event: ChatEvent,
    _el: HTMLElement,
    onText: (text: string) => void,
    toolUses: Array<{ name: string; input: Record<string, unknown> }>
  ): void {
    switch (event.type) {
      case "text_delta": {
        const data = event.data as { text?: string };
        if (data.text) onText(data.text);
        break;
      }
      case "tool_use": {
        const data = event.data as { name?: string; input?: Record<string, unknown> };
        if (data.name) {
          toolUses.push({ name: data.name, input: data.input || {} });
        }
        break;
      }
      case "done":
        break;
      default:
        break;
    }
  }

  private async handleSend(): Promise<void> {
    const text = this.inputEl.value.trim();
    if (!text) return;
    this.inputEl.value = "";
    await this.sendMessage(text);
  }

  // ---------------------------------------------------------------------------
  // DOM helpers
  // ---------------------------------------------------------------------------

  private appendSystemMessage(text: string): void {
    const div = this.messagesEl.createEl("div", { cls: "narrative-msg narrative-msg-system" });
    div.createEl("span", { text });
    this.scrollToBottom();
  }

  private appendUserMessage(text: string): HTMLElement {
    const div = this.messagesEl.createEl("div", { cls: "narrative-msg narrative-msg-user" });
    div.createEl("div", { cls: "narrative-msg-label", text: "You" });
    const content = div.createEl("div", { cls: "narrative-msg-content" });
    content.textContent = text;
    this.scrollToBottom();
    return div;
  }

  private appendAssistantMessage(text: string): HTMLElement {
    const div = this.messagesEl.createEl("div", { cls: "narrative-msg narrative-msg-assistant" });
    div.createEl("div", { cls: "narrative-msg-label", text: "Narrative AI" });
    const content = div.createEl("div", { cls: "narrative-msg-content" });
    content.textContent = text;

    // Streaming indicator — hidden after streaming ends (see sendMessage)
    const indicator = div.createEl("span", { cls: "narrative-stream-indicator" });
    indicator.textContent = "▋";

    this.scrollToBottom();
    return div;
  }

  private updateAssistantMessage(el: HTMLElement, text: string): void {
    const content = el.querySelector(".narrative-msg-content") as HTMLElement | null;
    if (content) {
      // Render markdown for the final output
      content.empty();
      try {
        void MarkdownRenderer.renderMarkdown(text, content, "", this.mdComponent);
      } catch {
        content.textContent = text;
      }
    }
    this.scrollToBottom();
  }

  private appendToolSummary(
    el: HTMLElement,
    toolUses: Array<{ name: string; input: Record<string, unknown> }>
  ): void {
    const details = el.createEl("details", { cls: "narrative-tool-details" });
    details.createEl("summary", { text: `${toolUses.length} tool call(s) used` });

    toolUses.forEach((t) => {
      const toolDiv = details.createEl("div", { cls: "narrative-tool-item" });
      toolDiv.createEl("code", { text: t.name });
      const inputStr = JSON.stringify(t.input, null, 2);
      if (inputStr !== "{}") {
        const pre = toolDiv.createEl("pre", { cls: "narrative-tool-input" });
        pre.textContent = inputStr;
      }
    });
  }

  private scrollToBottom(): void {
    this.messagesEl.scrollTop = this.messagesEl.scrollHeight;
  }
}
