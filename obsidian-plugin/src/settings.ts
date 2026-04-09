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
  provider: string; // 'cli' | 'api'
  apiKey: string;
  autoImport: boolean;
}

export const DEFAULT_SETTINGS: NarrativeSettings = {
  backendMode: "external",
  externalUrl: "http://localhost:8000",
  defaultBackendUrl: "http://localhost:8000",
  pythonPath: "python3",
  bookDir: "",
  provider: "cli",
  apiKey: "",
  autoImport: true,
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
          "Path to the directory containing .nos files. Leave empty to use vault root."
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
          .addOption("api", "Claude API (requires API key)")
          .setValue(this.plugin.settings.provider)
          .onChange(async (value) => {
            this.plugin.settings.provider = value;
            await this.plugin.saveSettings();
            this.display();
          })
      );

    if (this.plugin.settings.provider === "api") {
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
    }

    // ---------------------------------------------------------------------------
    // Auto-import section
    // ---------------------------------------------------------------------------

    containerEl.createEl("h3", { text: "Import" });

    new Setting(containerEl)
      .setName("Auto-import on save")
      .setDesc(
        "Automatically trigger book import when a .nos or .md file is saved."
      )
      .addToggle((toggle) =>
        toggle
          .setValue(this.plugin.settings.autoImport)
          .onChange(async (value) => {
            this.plugin.settings.autoImport = value;
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

