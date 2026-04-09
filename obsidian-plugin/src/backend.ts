/**
 * BackendManager — spawns and manages the narrative-os Python server process.
 * Only used when backendMode === 'managed'.
 */

import { ChildProcess } from "child_process";

// Use require for Node built-ins to avoid bundling issues
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { spawn } = require("child_process") as typeof import("child_process");

export class BackendManager {
  private proc: ChildProcess | null = null;
  private _running = false;
  private logLines: string[] = [];

  /**
   * Start the narrative-os Python server as a subprocess.
   * @param pythonPath Path to Python 3 executable
   * @param bookDir    Book directory (NOS_BOOK_DIR env var)
   */
  async start(pythonPath: string, bookDir: string): Promise<void> {
    if (this._running) return;

    const env: NodeJS.ProcessEnv = {
      ...process.env,
      NOS_BOOK_DIR: bookDir || process.cwd(),
      PYTHONUNBUFFERED: "1",
    };

    try {
      this.proc = spawn(
        pythonPath,
        ["-m", "uvicorn", "narrative_os.server:app", "--host", "127.0.0.1", "--port", "8000"],
        {
          env,
          stdio: ["ignore", "pipe", "pipe"],
          detached: false,
        }
      );

      this._running = true;

      this.proc.stdout?.on("data", (chunk: Buffer) => {
        const line = chunk.toString().trim();
        if (line) {
          this.logLines.push(`[OUT] ${line}`);
          if (this.logLines.length > 200) this.logLines.shift();
          console.log("[narrative-forge backend]", line);
        }
      });

      this.proc.stderr?.on("data", (chunk: Buffer) => {
        const line = chunk.toString().trim();
        if (line) {
          this.logLines.push(`[ERR] ${line}`);
          if (this.logLines.length > 200) this.logLines.shift();
          console.error("[narrative-forge backend]", line);
        }
      });

      this.proc.on("exit", (code, signal) => {
        console.log(`[narrative-forge backend] exited (code=${code}, signal=${signal})`);
        this._running = false;
        this.proc = null;
      });

      this.proc.on("error", (err) => {
        console.error("[narrative-forge backend] spawn error:", err);
        this._running = false;
        this.proc = null;
      });
    } catch (err) {
      this._running = false;
      this.proc = null;
      throw new Error(`Failed to start backend: ${err}`);
    }
  }

  /**
   * Stop the backend process gracefully.
   */
  async stop(): Promise<void> {
    if (!this.proc) return;

    return new Promise((resolve) => {
      if (!this.proc) {
        resolve();
        return;
      }

      const timeout = setTimeout(() => {
        this.proc?.kill("SIGKILL");
        resolve();
      }, 5000);

      this.proc.on("exit", () => {
        clearTimeout(timeout);
        resolve();
      });

      // Try SIGTERM first
      try {
        this.proc.kill("SIGTERM");
      } catch {
        clearTimeout(timeout);
        resolve();
      }

      this._running = false;
    });
  }

  isRunning(): boolean {
    return this._running && this.proc !== null;
  }

  getLogs(): string[] {
    return [...this.logLines];
  }

  /**
   * Poll /api/health every 500ms until it responds ok or timeout.
   */
  async waitReady(url: string, timeoutMs = 15000): Promise<boolean> {
    const healthUrl = `${url.replace(/\/$/, "")}/api/health`;
    const deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 1000);
        const res = await fetch(healthUrl, { signal: controller.signal }).finally(() => clearTimeout(timeoutId));
        if (res.ok) {
          const body = (await res.json()) as { status?: string };
          if (body.status === "ok") return true;
        }
      } catch {
        // Not ready yet
      }

      // Wait 500ms before retry
      await new Promise<void>((resolve) => setTimeout(resolve, 500));
    }

    return false;
  }
}
