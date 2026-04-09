/**
 * NarrativeTimelineView — horizontal scrollable timeline of narrative events.
 * Loads from {bookRoot}/timeline.md markdown table.
 */

import { ItemView, WorkspaceLeaf, normalizePath } from "obsidian";
import type NarrativePlugin from "./main";
import { NarrativeEvent } from "./event-modal";

// ---------------------------------------------------------------------------
// View
// ---------------------------------------------------------------------------

export class NarrativeTimelineView extends ItemView {
  static VIEW_TYPE = "narrative-timeline";

  constructor(leaf: WorkspaceLeaf, private plugin: NarrativePlugin) {
    super(leaf);
  }

  getViewType(): string {
    return NarrativeTimelineView.VIEW_TYPE;
  }

  getDisplayText(): string {
    return "Timeline";
  }

  getIcon(): string {
    return "clock";
  }

  async onOpen(): Promise<void> {
    await this.refresh();
  }

  async refresh(): Promise<void> {
    const { containerEl } = this;
    containerEl.empty();

    const container = containerEl.createDiv({ cls: "narrative-timeline-container" });

    // Toolbar
    const toolbar = container.createDiv({ cls: "narrative-timeline-toolbar" });

    const refreshBtn = toolbar.createEl("button", {
      text: "Refresh",
      cls: "narrative-btn-secondary",
    });
    refreshBtn.addEventListener("click", () => void this.refresh());

    const bookRoot = this.plugin.getCurrentBookRoot();

    if (!bookRoot) {
      toolbar.createEl("span", {
        text: "No book active",
        cls: "narrative-timeline-count",
      });

      // Canvas wrapper
      const canvasWrapper = container.createDiv({ cls: "narrative-timeline-canvas-wrapper" });
      const empty = canvasWrapper.createDiv({ cls: "narrative-timeline-empty" });
      empty.createEl("div", { text: "Open a file inside a book to see its timeline." });
      return;
    }

    // Load events
    const events = await this.loadEvents();

    toolbar.createEl("span", {
      text: `${events.length} event${events.length !== 1 ? "s" : ""}`,
      cls: "narrative-timeline-count",
    });

    // Canvas wrapper
    const canvasWrapper = container.createDiv({ cls: "narrative-timeline-canvas-wrapper" });

    if (events.length === 0) {
      const empty = canvasWrapper.createDiv({ cls: "narrative-timeline-empty" });
      empty.createEl("div", { text: "No timeline events yet." });
      empty.createEl("div", {
        text: 'Right-click text \u2192 "Add to timeline".',
        cls: "narrative-timeline-empty-hint",
      });
      return;
    }

    this.renderTimeline(events, canvasWrapper);
  }

  // ---------------------------------------------------------------------------
  // Load events from timeline.md
  // ---------------------------------------------------------------------------

  private async loadEvents(): Promise<NarrativeEvent[]> {
    const bookRoot = this.plugin.getCurrentBookRoot();
    if (!bookRoot) return [];

    const timelinePath = normalizePath(`${bookRoot}/timeline.md`);
    let content = "";
    try {
      content = await this.plugin.app.vault.adapter.read(timelinePath);
    } catch {
      return [];
    }

    const events: NarrativeEvent[] = [];
    const lines = content.split("\n");

    for (const line of lines) {
      if (!line.startsWith("|")) continue;
      if (line.includes("---")) continue;
      if (/^\|\s*title\s*\|/.test(line)) continue;

      const cells = line.split("|").map((c) => c.trim());
      // cells[0] is empty (before first |), cells[1..9] are columns
      if (cells.length < 9) continue;
      const title = cells[1];
      if (!title) continue;

      const ev: NarrativeEvent = { title };

      const year = parseInt(cells[2], 10);
      if (!isNaN(year)) ev.year = year;
      const month = parseInt(cells[3], 10);
      if (!isNaN(month)) ev.month = month;
      const day = parseInt(cells[4], 10);
      if (!isNaN(day)) ev.day = day;
      const hour = parseInt(cells[5], 10);
      if (!isNaN(hour)) ev.hour = hour;
      const minute = parseInt(cells[6], 10);
      if (!isNaN(minute)) ev.minute = minute;

      if (cells[7]) ev.location = cells[7];
      if (cells[8]) {
        ev.characters = cells[8]
          .split(",")
          .map((s) => s.trim())
          .filter(Boolean);
      }
      if (cells[9]) ev.chapterLink = cells[9];

      events.push(ev);
    }

    return events;
  }

  // ---------------------------------------------------------------------------
  // Render timeline
  // ---------------------------------------------------------------------------

  private renderTimeline(events: NarrativeEvent[], canvasWrapper: HTMLElement): void {

    const CARD_WIDTH = 180;
    const CARD_SPACING = 220;
    const START_X = 60;
    const CANVAS_HEIGHT = 480;
    const LINE_Y = 240;
    const STEM_LENGTH = 20;
    const CARD_HEIGHT_APPROX = 110;

    const canvasWidth = Math.max(
      (canvasWrapper.clientWidth || 800),
      START_X + events.length * CARD_SPACING + 120
    );

    const canvas = canvasWrapper.createDiv({ cls: "narrative-timeline-canvas" });
    canvas.style.position = "relative";
    canvas.style.width = `${canvasWidth}px`;
    canvas.style.height = `${CANVAS_HEIGHT}px`;

    // Horizontal line
    const line = canvas.createDiv({ cls: "narrative-timeline-line" });
    line.style.top = `${LINE_Y}px`;

    // Each event
    events.forEach((ev, idx) => {
      const above = idx % 2 === 0;
      const cx = START_X + idx * CARD_SPACING;

      // Dot
      const dot = canvas.createDiv({ cls: "narrative-event-dot" });
      dot.style.left = `${cx}px`;
      dot.style.top = `${LINE_Y}px`;
      dot.style.transform = "translate(-50%, -50%)";

      // Stem
      const stem = canvas.createDiv({ cls: "narrative-event-stem" });
      stem.style.left = `${cx}px`;
      if (above) {
        stem.style.top = `${LINE_Y - STEM_LENGTH}px`;
        stem.style.height = `${STEM_LENGTH}px`;
      } else {
        stem.style.top = `${LINE_Y}px`;
        stem.style.height = `${STEM_LENGTH}px`;
      }

      // Card
      const cardLeft = cx - CARD_WIDTH / 2;
      const cardTop = above
        ? LINE_Y - STEM_LENGTH - CARD_HEIGHT_APPROX
        : LINE_Y + STEM_LENGTH;

      const card = canvas.createDiv({ cls: "narrative-event-card" });
      card.style.left = `${cardLeft}px`;
      card.style.top = `${cardTop}px`;
      card.style.width = `${CARD_WIDTH}px`;

      // Left border color from first character
      const firstChar = ev.characters?.[0];
      const borderColor = firstChar ? charColor(stripWikilink(firstChar)) : "#7b9ab8";
      card.style.borderLeftColor = borderColor;

      // Title
      card.createDiv({ text: ev.title, cls: "narrative-event-card-title" });

      // Date
      const dateStr = formatEventDate(ev);
      if (dateStr) {
        card.createDiv({ text: dateStr, cls: "narrative-event-card-date" });
      }

      // Location
      if (ev.location) {
        card.createDiv({
          text: `\u{1F4CD} ${stripWikilink(ev.location)}`,
          cls: "narrative-event-card-meta",
        });
      }

      // Characters
      if (ev.characters?.length) {
        const names = ev.characters.map(stripWikilink).join(", ");
        card.createDiv({
          text: `\u{1F464} ${names}`,
          cls: "narrative-event-card-meta",
        });
      }

      // Click → open chapter link
      card.addEventListener("click", () => {
        if (ev.chapterLink) {
          const inner = ev.chapterLink.replace(/^\[\[|\]\]$/g, "");
          const [filePath, blockRef] = inner.split("#");
          const file = this.plugin.app.metadataCache.getFirstLinkpathDest(filePath, "");
          if (file) {
            const leaf = this.plugin.app.workspace.getLeaf();
            void leaf.openFile(file, {
              eState: { subpath: blockRef ? "#" + blockRef : "" },
            });
          }
        }
      });
    });
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function charColor(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash) % 360;
  return `hsl(${h}, 45%, 55%)`;
}

export function formatEventDate(ev: NarrativeEvent): string {
  const parts: string[] = [];
  if (ev.year !== undefined) parts.push(`Year ${ev.year}`);
  if (ev.month !== undefined) {
    const months = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
      "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    parts.push(months[(ev.month - 1)] ?? `M${ev.month}`);
  }
  if (ev.day !== undefined) parts.push(String(ev.day));
  if (ev.hour !== undefined) {
    parts.push(
      `${String(ev.hour).padStart(2, "0")}:${String(ev.minute ?? 0).padStart(2, "0")}`
    );
  }
  return parts.join(" ");
}

function stripWikilink(s: string): string {
  return s.replace(/^\[\[/, "").replace(/\]\]$/, "").replace(/#.*$/, "").trim();
}
