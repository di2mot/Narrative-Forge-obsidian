import * as http from "http";
import { App, Notice } from "obsidian";
import { LocalToolExecutor } from "./tools";

export class LocalServer {
  private server: http.Server | null = null;
  private app: App;

  constructor(app: App) {
    this.app = app;
  }

  start(port: number = 18000) {
    if (this.server) return;

    this.server = http.createServer((req, res) => {
      res.setHeader("Access-Control-Allow-Origin", "*");
      res.setHeader("Access-Control-Allow-Methods", "POST, OPTIONS");
      res.setHeader("Access-Control-Allow-Headers", "Content-Type");

      if (req.method === "OPTIONS") {
        res.writeHead(200);
        res.end();
        return;
      }

      if (req.method === "POST" && req.url === "/execute_tool") {
        let bodyStr = "";
        req.on("data", (chunk) => {
          bodyStr += chunk;
        });
        
        req.on("end", async () => {
          try {
            const body = JSON.parse(bodyStr);
            const toolName = body.name;
            const input = body.input || {};
            const bookDir = body.book_dir || "";

            const executor = new LocalToolExecutor(this.app, bookDir);
            let result = "";

            if (toolName === "edit_scene") {
              result = await executor.edit_scene(input);
            } else if (toolName === "write_scene") {
              result = await executor.write_scene(input);
            } else if (toolName === "append_to_chapter") {
              result = await executor.append_to_chapter(input);
            } else if (toolName === "search_semantic") {
              result = await executor.search_semantic(input);
            } else if (toolName === "read_scene") {
              result = await executor.read_scene(input as any);
            } else if (toolName === "read_chapter") {
              result = await executor.read_chapter(input as any);
            } else if (toolName === "get_book_info") {
              result = await executor.get_book_info(input);
            } else {
              result = `Unknown or unsupported local tool: ${toolName}`;
            }

            res.writeHead(200, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "ok", result }));
          } catch (e: any) {
            console.error("[NOS Local Server] Error:", e);
            res.writeHead(500, { "Content-Type": "application/json" });
            res.end(JSON.stringify({ status: "error", message: e.message || String(e) }));
          }
        });
      } else {
        res.writeHead(404);
        res.end();
      }
    });

    this.server.listen(port, "127.0.0.1", () => {
      console.log(`[Narrative Forge] Local bridge server listening on http://127.0.0.1:${port}`);
    });

    this.server.on("error", (e: NodeJS.ErrnoException) => {
      console.error("[Narrative Forge] Local bridge server error:", e);
      if (e.code === "EADDRINUSE") {
        new Notice("Narrative Forge: Port 18000 is already in use. Python → Obsidian write operations will not work until the conflict is resolved.");
      }
    });
  }

  stop() {
    if (this.server) {
      this.server.close();
      this.server = null;
      console.log("[Narrative Forge] Local bridge server stopped.");
    }
  }
}
