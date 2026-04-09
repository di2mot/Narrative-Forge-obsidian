/**
 * Writing session tracker — status bar widget.
 *
 * Shows: 📖 25:00  +312 / -47
 * Click → open modal to start/stop session.
 */

import { App, Modal, Plugin, Setting } from "obsidian";

function countWords(text: string): number {
  return text.trim() === "" ? 0 : text.trim().split(/\s+/).length;
}

function fmtTime(seconds: number): string {
  const m = Math.floor(seconds / 60).toString().padStart(2, "0");
  const s = (seconds % 60).toString().padStart(2, "0");
  return `${m}:${s}`;
}

// ---------------------------------------------------------------------------
// Session state
// ---------------------------------------------------------------------------

interface SessionState {
  active: boolean;
  durationSec: number;
  remainingSec: number;
  written: number;
  deleted: number;
  lastWordCount: number;
}

// ---------------------------------------------------------------------------
// Modal: start session
// ---------------------------------------------------------------------------

class SessionModal extends Modal {
  private minutes = 25;
  private onStart: (minutes: number) => void;
  private onStop: () => void;
  private isActive: boolean;
  private written: number;
  private deleted: number;

  constructor(
    app: App,
    isActive: boolean,
    written: number,
    deleted: number,
    onStart: (minutes: number) => void,
    onStop: () => void,
  ) {
    super(app);
    this.isActive = isActive;
    this.written = written;
    this.deleted = deleted;
    this.onStart = onStart;
    this.onStop = onStop;
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.createEl("h2", { text: "Writing session" });

    if (this.isActive) {
      contentEl.createEl("p", {
        text: `Session in progress: +${this.written} written, -${this.deleted} deleted.`,
      });

      new Setting(contentEl).addButton((btn) =>
        btn
          .setButtonText("Stop session")
          .setWarning()
          .onClick(() => {
            this.onStop();
            this.close();
          })
      );
      return;
    }

    new Setting(contentEl)
      .setName("Duration (minutes)")
      .addSlider((sl) =>
        sl
          .setLimits(5, 120, 5)
          .setValue(this.minutes)
          .setDynamicTooltip()
          .onChange((v) => { this.minutes = v; })
      );

    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText("Start")
        .setCta()
        .onClick(() => {
          this.onStart(this.minutes);
          this.close();
        })
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

// ---------------------------------------------------------------------------
// Main class
// ---------------------------------------------------------------------------

export class WritingSession {
  private plugin: Plugin;
  private statusEl: HTMLElement;
  private state: SessionState = {
    active: false,
    durationSec: 0,
    remainingSec: 0,
    written: 0,
    deleted: 0,
    lastWordCount: 0,
  };
  private ticker: ReturnType<typeof setInterval> | null = null;

  constructor(plugin: Plugin) {
    this.plugin = plugin;
    const item = plugin.addStatusBarItem();
    item.addClass("narrative-session-bar");
    item.style.cursor = "pointer";
    this.statusEl = item;

    this.renderIdle();

    item.addEventListener("click", () => this.openModal());

    // Track word changes on every editor keystroke
    plugin.registerEvent(
      plugin.app.workspace.on("editor-change", (editor) => {
        if (!this.state.active) return;
        const current = countWords(editor.getValue());
        const delta = current - this.state.lastWordCount;
        if (delta > 0) this.state.written += delta;
        else if (delta < 0) this.state.deleted += Math.abs(delta);
        this.state.lastWordCount = current;
        this.renderActive();
      })
    );
  }

  private openModal(): void {
    new SessionModal(
      this.plugin.app,
      this.state.active,
      this.state.written,
      this.state.deleted,
      (minutes) => this.start(minutes),
      () => this.stop(),
    ).open();
  }

  private start(minutes: number): void {
    // Snapshot current word count
    const editor = this.plugin.app.workspace.activeEditor?.editor;
    this.state = {
      active: true,
      durationSec: minutes * 60,
      remainingSec: minutes * 60,
      written: 0,
      deleted: 0,
      lastWordCount: editor ? countWords(editor.getValue()) : 0,
    };

    this.ticker = setInterval(() => this.tick(), 1000);
    this.renderActive();
  }

  private stop(): void {
    if (this.ticker) {
      clearInterval(this.ticker);
      this.ticker = null;
    }
    this.state.active = false;
    this.renderIdle();
  }

  private tick(): void {
    this.state.remainingSec -= 1;
    if (this.state.remainingSec <= 0) {
      this.stop();
      // Flash done state briefly
      this.statusEl.setText(`✅ Done! +${this.state.written} / -${this.state.deleted}`);
      return;
    }
    this.renderActive();
  }

  private renderIdle(): void {
    this.statusEl.setText("📖");
    this.statusEl.setAttr("title", "Start writing session");
    this.statusEl.removeClass("narrative-session-active");
  }

  private renderActive(): void {
    const { remainingSec, written, deleted } = this.state;
    this.statusEl.setText(
      `📖 ${fmtTime(remainingSec)}  +${written} / -${deleted}`
    );
    this.statusEl.setAttr("title", "Writing session active — click to stop");
    this.statusEl.addClass("narrative-session-active");
  }

  destroy(): void {
    this.stop();
  }
}
