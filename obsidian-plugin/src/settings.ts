/**
 * Plugin settings: interface, defaults, and SettingTab UI.
 */

import { App, PluginSettingTab, Setting, Notice } from "obsidian";
import type NarrativePlugin from "./main";

export interface NarrativeSettings {
  backendMode: "external" | "managed";
  externalUrl: string;
  /** Default backend URL used when no .narrative-book.json is found for the active file. */
  defaultBackendUrl: string;
  pythonPath: string;
  bookDir: string; // empty = vault root
  provider: string; // 'cli' | 'anthropic' | 'openai' | 'gemini' | 'local'
  apiKey: string;
  openaiApiKey: string;
  geminiApiKey: string;
  localBaseUrl: string;
  modelName: string;
  autoImport: boolean;
  embeddingModel: "en" | "multilingual";
}

export const DEFAULT_SETTINGS: NarrativeSettings = {
  backendMode: "external",
  externalUrl: "http://localhost:8000",
  defaultBackendUrl: "http://localhost:8000",
  pythonPath: "python3",
  bookDir: "",
  provider: "cli",
  apiKey: "",
  openaiApiKey: "",
  geminiApiKey: "",
  localBaseUrl: "http://localhost:11434/v1",
  modelName: "",
  autoImport: true,
  embeddingModel: "multilingual",
};

export class NarrativeSettingTab extends PluginSettingTab {
  plugin: NarrativePlugin;

  constructor(app: App, plugin: NarrativePlugin) {
    super(app, plugin);
    this.plugin = plugin;
  }

  display(): void {
    const { containerEl } = this;
    containerEl.empty();

    containerEl.createEl("h2", { text: "Narrative Forge Settings" });

    // ---------------------------------------------------------------------------
    // Backend section
    // ---------------------------------------------------------------------------

    containerEl.createEl("h3", { text: "Backend" });

    new Setting(containerEl)
      .setName("Backend mode")
      .setDesc("How to connect to the narrative-forge Python backend.")
      .addDropdown((drop) =>
        drop
          .addOption("external", "External URL (backend runs separately)")
          .addOption("managed", "Managed (plugin starts/stops backend)")
          .setValue(this.plugin.settings.backendMode)
          .onChange(async (value) => {
            this.plugin.settings.backendMode = value as "external" | "managed";
            await this.plugin.saveSettings();
            this.display(); // Re-render to show/hide options
          })
      );

    if (this.plugin.settings.backendMode === "external") {
      new Setting(containerEl)
        .setName("Backend URL")
        .setDesc("URL of the running narrative-forge server (e.g. http://localhost:8000).")
        .addText((text) =>
          text
            .setPlaceholder("http://localhost:8000")
            .setValue(this.plugin.settings.externalUrl)
            .onChange(async (value) => {
              this.plugin.settings.externalUrl = value.trim();
              await this.plugin.saveSettings();
              this.plugin.api.updateBaseUrl(this.plugin.getBackendUrl());
            })
        );
    } else {
      new Setting(containerEl)
        .setName("Python path")
        .setDesc("Path to Python 3 executable (or 'python3').")
        .addText((text) =>
          text
            .setPlaceholder("python3")
            .setValue(this.plugin.settings.pythonPath)
            .onChange(async (value) => {
              this.plugin.settings.pythonPath = value.trim();
              await this.plugin.saveSettings();
            })
        );

      new Setting(containerEl)
        .setName("Book directory")
        .setDesc(
          "Path to the directory containing .md chapter files. Leave empty to use vault root."
        )
        .addText((text) =>
          text
            .setPlaceholder("/path/to/book (empty = vault root)")
            .setValue(this.plugin.settings.bookDir)
            .onChange(async (value) => {
              this.plugin.settings.bookDir = value.trim();
              await this.plugin.saveSettings();
            })
        );
    }

    new Setting(containerEl)
      .setName("Default backend URL")
      .setDesc(
        "Fallback URL used when the active file is not inside a book folder with .narrative-book.json."
      )
      .addText((text) =>
        text
          .setPlaceholder("http://localhost:8000")
          .setValue(this.plugin.settings.defaultBackendUrl)
          .onChange(async (value) => {
            this.plugin.settings.defaultBackendUrl = value.trim();
            await this.plugin.saveSettings();
          })
      );

    // Test connection button
    new Setting(containerEl)
      .setName("Test connection")
      .setDesc("Check if the backend is reachable.")
      .addButton((btn) =>
        btn
          .setButtonText("Test")
          .setCta()
          .onClick(async () => {
            btn.setButtonText("Testing...");
            btn.setDisabled(true);
            try {
              const healthy = await this.plugin.api.health();
              if (healthy) {
                new Notice("Narrative Forge: Connected successfully!");
                btn.setButtonText("Connected");
              } else {
                new Notice("Narrative Forge: Backend unreachable.");
                btn.setButtonText("Failed");
              }
            } catch {
              new Notice("Narrative Forge: Connection error.");
              btn.setButtonText("Error");
            } finally {
              btn.setDisabled(false);
              setTimeout(() => btn.setButtonText("Test"), 3000);
            }
          })
      );

    // ---------------------------------------------------------------------------
    // LLM Provider section
    // ---------------------------------------------------------------------------

    containerEl.createEl("h3", { text: "LLM Provider" });

    new Setting(containerEl)
      .setName("Provider")
      .setDesc("Which LLM to use for AI features.")
      .addDropdown((drop) =>
        drop
          .addOption("cli", "Claude CLI (uses local Claude subscription)")
          .addOption("anthropic", "Anthropic API (Claude)")
          .addOption("openai", "OpenAI API (ChatGPT)")
          .addOption("gemini", "Google Gemini API")
          .addOption("local", "Local LLM (Ollama, LM Studio)")
          .setValue(this.plugin.settings.provider === "api" ? "anthropic" : this.plugin.settings.provider)
          .onChange(async (value) => {
            this.plugin.settings.provider = value;
            
            const defaults: Record<string, string> = {
              anthropic: "claude-sonnet-4-6",
              openai: "gpt-4o",
              gemini: "gemini-3-flash-preview",
              local: "",
            };
            if (value in defaults) {
              this.plugin.settings.modelName = defaults[value];
            }
            
            await this.plugin.saveSettings();
            this.display();
          })
      );

    if (this.plugin.settings.provider !== "cli") {
      new Setting(containerEl)
        .setName("Model name")
        .setDesc("Specific model to use (e.g., gpt-4o, claude-3-5-sonnet-20241022)")
        .addText((text) =>
          text
            .setPlaceholder("Model ID")
            .setValue(this.plugin.settings.modelName)
            .onChange(async (value) => {
              this.plugin.settings.modelName = value.trim();
              await this.plugin.saveSettings();
            })
        );
    }

    if (this.plugin.settings.provider === "anthropic" || this.plugin.settings.provider === "api") {
      new Setting(containerEl)
        .setName("Anthropic API key")
        .setDesc("Your Anthropic API key (sk-ant-...).")
        .addText((text) => {
          text
            .setPlaceholder("sk-ant-...")
            .setValue(this.plugin.settings.apiKey)
            .onChange(async (value) => {
              this.plugin.settings.apiKey = value.trim();
              await this.plugin.saveSettings();
            });
          text.inputEl.type = "password";
          return text;
        });
    } else if (this.plugin.settings.provider === "openai") {
      new Setting(containerEl)
        .setName("OpenAI API key")
        .setDesc("Your OpenAI API key (sk-...).")
        .addText((text) => {
          text
            .setPlaceholder("sk-...")
            .setValue(this.plugin.settings.openaiApiKey)
            .onChange(async (value) => {
              this.plugin.settings.openaiApiKey = value.trim();
              await this.plugin.saveSettings();
            });
          text.inputEl.type = "password";
          return text;
        });
    } else if (this.plugin.settings.provider === "gemini") {
      new Setting(containerEl)
        .setName("Gemini API key")
        .setDesc("Your Google Gemini API key.")
        .addText((text) => {
          text
            .setPlaceholder("AIza...")
            .setValue(this.plugin.settings.geminiApiKey)
            .onChange(async (value) => {
              this.plugin.settings.geminiApiKey = value.trim();
              await this.plugin.saveSettings();
            });
          text.inputEl.type = "password";
          return text;
        });
    } else if (this.plugin.settings.provider === "local") {
      new Setting(containerEl)
        .setName("Local Base URL")
        .setDesc("OpenAI-compatible endpoint (Ollama: http://localhost:11434/v1, LM Studio: http://localhost:1234/v1).")
        .addText((text) => {
          text
            .setPlaceholder("http://localhost:11434/v1")
            .setValue(this.plugin.settings.localBaseUrl)
            .onChange(async (value) => {
              this.plugin.settings.localBaseUrl = value.trim();
              await this.plugin.saveSettings();
            });
          return text;
        });
    }

    // ---------------------------------------------------------------------------
    // Auto-import section
    // ---------------------------------------------------------------------------

    containerEl.createEl("h3", { text: "Import" });

    new Setting(containerEl)
      .setName("Auto-import on save")
      .setDesc(
        "Automatically trigger book import when a .md file is saved."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoImport)
          .onChange(async (value) => {
            this.plugin.settings.autoImport = value;
            await this.plugin.saveSettings();
          })
      );

    new Setting(containerEl)
      .setName("Embedding model")
      .setDesc(
        "Model used to index and search your book. Use Multilingual for non-English text. " +
        "Changing this requires a Force reimport to rebuild the index."
      )
      .addDropdown((drop) =>
        drop
          .addOption("en", "English (all-MiniLM-L6-v2, faster)")
          .addOption("multilingual", "Multilingual (paraphrase-multilingual-MiniLM-L12-v2)")
          .setValue(this.plugin.settings.embeddingModel)
          .onChange(async (value: string) => {
            this.plugin.settings.embeddingModel = value as "en" | "multilingual";
            await this.plugin.saveSettings();
          })
      );

    // ---------------------------------------------------------------------------
    // Books section
    // ---------------------------------------------------------------------------

    containerEl.createEl("h3", { text: "Books" });

    new Setting(containerEl)
      .setName("Create new book")
      .setDesc(
        "Create a new book folder with .narrative-book.json marker and default structure."
      )
      .addButton((btn) =>
        btn
          .setButtonText("Create new book...")
          .onClick(() => {
            // Trigger the create-book command from the plugin
            const cmd = (this.app as unknown as { commands?: { executeCommandById(id: string): boolean } }).commands;
            if (cmd) {
              cmd.executeCommandById("narrative-forge:create-book");
            }
          })
      );

    // ---------------------------------------------------------------------------
    // Info section
    // ---------------------------------------------------------------------------

    containerEl.createEl("h3", { text: "About" });
    const infoDiv = containerEl.createEl("div", { cls: "narrative-settings-info" });
    infoDiv.createEl("p", {
      text: "Narrative Forge v0.4.0 — AI-powered writing assistant for fiction authors.",
    });
    infoDiv.createEl("p", {
      text: "Start the backend with: uvicorn narrative_os.server:app --reload",
      cls: "narrative-settings-code",
    });
  }
}

