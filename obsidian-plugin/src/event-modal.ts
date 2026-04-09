/**
 * EventModal — simplified modal for creating narrative timeline events.
 */

import { App, Modal, Setting, Notice } from "obsidian";

// ---------------------------------------------------------------------------
// Data types
// ---------------------------------------------------------------------------

export interface NarrativeEvent {
  title: string;
  year?: number;
  month?: number;
  day?: number;
  hour?: number;
  minute?: number;
  location?: string;    // wikilink like "[[Andruil]]"
  characters?: string[]; // wikilinks like ["[[Artur]]"]
  chapterLink?: string; // "[[filename#^tl-timestamp]]"
}

// ---------------------------------------------------------------------------
// Modal
// ---------------------------------------------------------------------------

export class EventModal extends Modal {
  private event: Partial<NarrativeEvent> = {};

  constructor(
    app: App,
    private onSubmit: (event: NarrativeEvent) => void
  ) {
    super(app);
  }

  onOpen(): void {
    const { contentEl } = this;
    contentEl.empty();
    contentEl.createEl("h2", { text: "Add timeline event" });

    // Title
    new Setting(contentEl)
      .setName("Title")
      .setDesc("Required — short name for this event.")
      .addText((text) => {
        text
          .setPlaceholder("The Siege of Andruil")
          .onChange((v) => {
            this.event.title = v.trim();
          });
        return text;
      });

    // Date row: Year | Month | Day
    const dateRow = contentEl.createDiv({ cls: "narrative-event-date-row" });
    dateRow.createEl("label", { text: "Date", cls: "narrative-event-row-label" });

    const dateFields = dateRow.createDiv({ cls: "narrative-event-row-fields" });

    const yearInput = dateFields.createEl("input", {
      type: "number",
      placeholder: "Year",
      cls: "narrative-event-num-input",
    });
    yearInput.addEventListener("input", () => {
      const v = yearInput.value.trim();
      this.event.year = v ? parseInt(v, 10) : undefined;
    });

    const monthInput = dateFields.createEl("input", {
      type: "number",
      placeholder: "Month",
      cls: "narrative-event-num-input",
    });
    monthInput.addEventListener("input", () => {
      const v = monthInput.value.trim();
      this.event.month = v ? parseInt(v, 10) : undefined;
    });

    const dayInput = dateFields.createEl("input", {
      type: "number",
      placeholder: "Day",
      cls: "narrative-event-num-input",
    });
    dayInput.addEventListener("input", () => {
      const v = dayInput.value.trim();
      this.event.day = v ? parseInt(v, 10) : undefined;
    });

    // Time row: Hour | Minute
    const timeRow = contentEl.createDiv({ cls: "narrative-event-date-row" });
    timeRow.createEl("label", { text: "Time", cls: "narrative-event-row-label" });

    const timeFields = timeRow.createDiv({ cls: "narrative-event-row-fields" });

    const hourInput = timeFields.createEl("input", {
      type: "number",
      placeholder: "Hour",
      cls: "narrative-event-num-input",
    });
    hourInput.addEventListener("input", () => {
      const v = hourInput.value.trim();
      this.event.hour = v ? parseInt(v, 10) : undefined;
    });

    const minuteInput = timeFields.createEl("input", {
      type: "number",
      placeholder: "Minute",
      cls: "narrative-event-num-input",
    });
    minuteInput.addEventListener("input", () => {
      const v = minuteInput.value.trim();
      this.event.minute = v ? parseInt(v, 10) : undefined;
    });

    // Location
    new Setting(contentEl)
      .setName("Location")
      .setDesc("Type a name — it will be wrapped in [[]] automatically.")
      .addText((text) => {
        text
          .setPlaceholder("Andruil")
          .onChange((v) => {
            this.event.location = v.trim() ? `[[${v.trim()}]]` : undefined;
          });
        return text;
      });

    // Characters
    new Setting(contentEl)
      .setName("Characters")
      .setDesc("Comma-separated names — each will be wrapped in [[]].")
      .addText((text) => {
        text
          .setPlaceholder("Artur, Sam")
          .onChange((v) => {
            this.event.characters = parseCharacters(v);
          });
        return text;
      });

    // Submit button
    new Setting(contentEl).addButton((btn) =>
      btn
        .setButtonText("Add to timeline")
        .setCta()
        .onClick(() => {
          const title = this.event.title?.trim();
          if (!title) {
            new Notice("Please enter an event title.");
            return;
          }
          const result: NarrativeEvent = {
            title,
            ...(this.event.year !== undefined && { year: this.event.year }),
            ...(this.event.month !== undefined && { month: this.event.month }),
            ...(this.event.day !== undefined && { day: this.event.day }),
            ...(this.event.hour !== undefined && { hour: this.event.hour }),
            ...(this.event.minute !== undefined && { minute: this.event.minute }),
            ...(this.event.location && { location: this.event.location }),
            ...(this.event.characters?.length && { characters: this.event.characters }),
            ...(this.event.chapterLink && { chapterLink: this.event.chapterLink }),
          };
          this.close();
          this.onSubmit(result);
        })
    );
  }

  onClose(): void {
    this.contentEl.empty();
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse comma-separated names into [[Name]] wikilinks. */
function parseCharacters(raw: string): string[] | undefined {
  const names = raw
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  return names.length ? names.map((n) => `[[${n}]]`) : undefined;
}
