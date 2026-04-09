/**
 * Chat panel — right sidebar leaf with SSE streaming to /api/chat.
 */

import { ItemView, WorkspaceLeaf, MarkdownRenderer, MarkdownView, Notice, Component, FileSystemAdapter } from "obsidian";
import type { NarrativeAPI, ChatEvent } from "./api";
import type NarrativePlugin from "./main";

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
  private messagesEl!: HTMLElement;
  private inputEl!: HTMLTextAreaElement;
  private sendBtn!: HTMLButtonElement;
  private isStreaming = false;
  private mdComponent: Component;

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

  async onOpen(): Promise<void> {
    const root = this.containerEl.children[1] as HTMLElement;
    root.empty();
    root.addClass("narrative-chat");
    this.mdComponent.load();

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

    // Prefer active MarkdownView; fall back to last focused .md file
    const view = this.plugin.app.workspace.getActiveViewOfType(MarkdownView);
    const relativePath = view?.file?.path ?? this.plugin.lastActiveMdPath ?? "";
    const filePath = vaultPath && relativePath ? `${vaultPath}/${relativePath}` : relativePath;

    return {
      fileContent: view?.editor.getValue() ?? "",
      selection: view?.editor.getSelection() ?? "",
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
    console.log("[NOS chat] sendMessage called, isStreaming=", this.isStreaming, "text=", text.slice(0, 30));
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
      const provider = this.plugin.settings.provider === "api" ? "api" : undefined;
      const apiKey = this.plugin.settings.provider === "api"
        ? this.plugin.settings.apiKey || undefined
        : undefined;

      // Build API messages: enrich the last user message with active file context
      const { messages: apiMessages, bookDir } = await this.buildApiMessages();
      const language = this.plugin.getCurrentBookLanguage();
      console.log("[NOS chat] sending to", this.api.baseUrl, "bookDir=", bookDir, "lang=", language);

      for await (const event of this.api.chatStream(
        apiMessages,
        provider,
        apiKey,
        bookDir,
        language,
      )) {
        this.handleChatEvent(event, assistantEl, (text) => {
          fullText += text;
          this.updateAssistantMessage(assistantEl, fullText);
        }, toolUses);
      }

      this.messages.push({
        role: "assistant",
        content: fullText,
        toolUses: toolUses.length > 0 ? toolUses : undefined,
      });

      if (toolUses.length > 0) {
        this.appendToolSummary(assistantEl, toolUses);
      }
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err);
      this.updateAssistantMessage(
        assistantEl,
        `Error: ${errMsg}\n\nIs the backend running at ${this.plugin.getBackendUrl()}?`
      );
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
