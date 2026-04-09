/**
 * Typed HTTP client for narrative-os backend API.
 * All requests go through a configurable base URL.
 */

export interface Character {
  name: string;
  description?: string;
  aliases?: string;
  first_seen_chapter?: number;
}


export interface ChatEvent {
  type: string;
  data: Record<string, unknown>;
}

export interface ImportResult {
  chapters_imported: number;
  chapters_skipped: number;
  characters_found: number;
  errors: string[];
  summary: string;
}

export interface HealthResult {
  status: string;
  book_dir: string;
  chapters: number;
  characters: number;
  provider: string;
}

export class NarrativeAPI {
  constructor(public baseUrl: string) {}

  updateBaseUrl(url: string): void {
    this.baseUrl = url.replace(/\/$/, "");
  }

  setBaseUrl(url: string): void {
    this.baseUrl = url.replace(/\/$/, "");
  }

  private async request<T>(
    path: string,
    options: RequestInit = {}
  ): Promise<T> {
    const url = `${this.baseUrl}${path}`;
    const response = await fetch(url, {
      headers: {
        "Content-Type": "application/json",
        ...options.headers,
      },
      ...options,
    });

    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      throw new Error(`API ${options.method || "GET"} ${path} → ${response.status}: ${text}`);
    }

    return response.json() as Promise<T>;
  }

  async health(): Promise<boolean> {
    try {
      const result = await this.request<HealthResult>("/api/health");
      return result.status === "ok";
    } catch {
      return false;
    }
  }

  async healthDetails(): Promise<HealthResult | null> {
    try {
      return await this.request<HealthResult>("/api/health");
    } catch {
      return null;
    }
  }

  async importBook(force = false, bookDir?: string, language?: string): Promise<ImportResult> {
    const params = new URLSearchParams({ force: String(force) });
    if (bookDir) params.set("book_dir", bookDir);
    if (language) params.set("language", language);
    return this.request<ImportResult>(`/api/import?${params}`, { method: "POST" });
  }

  /**
   * Stream chat events from /api/chat via SSE.
   * Yields parsed ChatEvent objects.
   */
  async *chatStream(
    messages: Array<{ role: string; content: string }>,
    provider?: string,
    apiKey?: string,
    bookDir?: string,
    language?: string,
  ): AsyncGenerator<ChatEvent> {
    const url = `${this.baseUrl}/api/chat`;
    const body: Record<string, unknown> = { messages };
    if (provider) body["provider"] = provider;
    if (apiKey) body["api_key"] = apiKey;
    if (bookDir) body["book_dir"] = bookDir;
    if (language) body["language"] = language;

    const response = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const text = await response.text().catch(() => response.statusText);
      throw new Error(`Chat API error ${response.status}: ${text}`);
    }

    if (!response.body) {
      throw new Error("Response body is null");
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");
        // Keep the last (potentially incomplete) line in the buffer
        buffer = lines.pop() ?? "";

        for (const line of lines) {
          const trimmed = line.trim();
          if (trimmed.startsWith("data: ")) {
            const jsonStr = trimmed.slice(6);
            if (jsonStr === "[DONE]") return;
            try {
              const event = JSON.parse(jsonStr) as ChatEvent;
              yield event;
              if (event.type === "done") return;
            } catch {
              // Skip malformed JSON lines
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}
