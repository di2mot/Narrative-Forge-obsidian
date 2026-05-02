/**
 * Context menu: right-click on selected text → assign character / send to chat / add to timeline.
 */

import { Editor, Menu, Notice, Plugin, SuggestModal, App, normalizePath } from "obsidian";
import type { Character } from "./api";
import type { NarrativeChatView } from "./chat";
import type NarrativePlugin from "./main";
import { EventModal, NarrativeEvent } from "./event-modal";

// ---------------------------------------------------------------------------
// Character suggest modal (for long character lists)
// ---------------------------------------------------------------------------

class CharacterSuggestModal extends SuggestModal<Character> {
  private onChoose: (char: Character) => void;
  private characters: Character[];

  constructor(
    app: App,
    characters: Character[],
    onChoose: (char: Character) => void
  ) {
    super(app);
    this.characters = characters;
    this.onChoose = onChoose;
    this.setPlaceholder("Type to filter characters...");
  }

  getSuggestions(query: string): Character[] {
    const q = query.toLowerCase();
    return this.characters.filter((c) =>
      c.name.toLowerCase().includes(q)
    );
  }

  renderSuggestion(char: Character, el: HTMLElement): void {
    el.createEl("div", { text: char.name, cls: "narrative-suggest-name" });
    if (char.description) {
      el.createEl("small", {
        text: char.description.slice(0, 80),
        cls: "narrative-suggest-desc",
      });
    }
  }

  onChooseSuggestion(char: Character): void {
    this.onChoose(char);
  }
}

// ---------------------------------------------------------------------------
// Assign character prefix to selection
// ---------------------------------------------------------------------------

/**
 * Replace or prepend [character: Name] — on the line(s) of the selection.
 * - If the line already starts with [character: X] — , replace just the name.
 * - Otherwise prepend the full prefix before the selected text.
 */
function assignCharacterToSelection(editor: Editor, char: Character): void {
  if (!editor.somethingSelected()) {
    new Notice("Select some text first.");
    return;
  }

  const cursor = editor.getCursor("from");
  const line = editor.getLine(cursor.line);
  const prefix = `[character: ${char.name}] — `;

  // Pattern to detect existing dialogue prefix
  const existingMatch = /^\[character:\s*[^\]]+\]\s*—\s*/.exec(line);

  if (existingMatch) {
    // Replace just the existing prefix with the new one
    const newLine = prefix + line.slice(existingMatch[0].length);
    editor.setLine(cursor.line, newLine);
    new Notice(`Character changed to ${char.name}`);
  } else {
    // Prepend [character: Name] — before the selection on that line
    // Get selection start position within the line
    const selFrom = editor.getCursor("from");
    const selTo = editor.getCursor("to");

    if (selFrom.line !== selTo.line) {
      // Multi-line: apply to each line
      for (let ln = selFrom.line; ln <= selTo.line; ln++) {
        const lineText = editor.getLine(ln);
        const existingOnLine = /^\[character:\s*[^\]]+\]\s*—\s*/.exec(lineText);
        if (existingOnLine) {
          editor.setLine(ln, prefix + lineText.slice(existingOnLine[0].length));
        } else {
          editor.setLine(ln, prefix + lineText);
        }
      }
      new Notice(`Assigned ${char.name} to ${selTo.line - selFrom.line + 1} lines`);
    } else {
      // Single line: prepend at start of line (or at selection start)
      const colOffset = selFrom.ch;
      const before = line.slice(0, colOffset);
      const selected = line.slice(colOffset, selTo.ch);
      const after = line.slice(selTo.ch);

      if (colOffset === 0) {
        // Selection starts at line beginning — prepend
        editor.setLine(cursor.line, prefix + line);
      } else {
        // Selection is mid-line: wrap selection
        editor.setLine(cursor.line, before + prefix + selected + after);
      }
      new Notice(`Assigned: ${char.name}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Add to timeline
// ---------------------------------------------------------------------------

/**
 * Open the EventModal, insert a block ID at the cursor position in the active
 * file, build the chapter link, then update {bookRoot}/timeline.md.
 */
async function addTimelineEntry(plugin: NarrativePlugin, editor: Editor): Promise<void> {
  new EventModal(plugin.app, async (event) => {
    const bookRoot = plugin.getCurrentBookRoot();
    if (!bookRoot) {
      new Notice("No book found for this file.");
      return;
    }

    // 1. Insert block ID at cursor position in current file
    const activeFile = plugin.app.workspace.getActiveFile();
    if (!activeFile) return;

    const timestamp = Date.now();
    const blockId = `^tl-${timestamp}`;

    // Insert blockId at end of current line
    const cursor = editor.getCursor();
    const lineText = editor.getLine(cursor.line);
    editor.setLine(cursor.line, lineText + " " + blockId);

    // Build chapter link
    event.chapterLink = `[[${activeFile.basename}#${blockId}]]`;

    // 2. Update timeline.md
    await updateTimelineFile(plugin, bookRoot, event);
  }).open();
}

/**
 * Read, parse, add, sort, and rewrite {bookRoot}/timeline.md.
 */
async function updateTimelineFile(
  plugin: NarrativePlugin,
  bookRoot: string,
  newEvent: NarrativeEvent
): Promise<void> {
  const vault = plugin.app.vault;
  const timelinePath = normalizePath(`${bookRoot}/timeline.md`);

  // Read existing content (or start fresh)
  let existing = "";
  try {
    existing = await vault.adapter.read(timelinePath);
  } catch {
    // File does not exist yet — we'll create it
  }

  // Parse existing table rows
  const events: NarrativeEvent[] = [];
  const lines = existing.split("\n");
  for (const line of lines) {
    if (!line.startsWith("|")) continue;
    // Skip header and separator rows
    if (line.includes("---")) continue;
    if (/^\|\s*title\s*\|/.test(line)) continue;

    const cells = line.split("|").map((c) => c.trim());
    // cells[0] is empty (before first |), cells[1..9] are the columns
    // title | year | month | day | hour | minute | location | characters | chapter
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

  // Add new event
  events.push(newEvent);

  // Sort: year → month → day → hour → minute (undefined = Infinity)
  events.sort((a, b) => {
    const av = [
      a.year ?? Infinity,
      a.month ?? Infinity,
      a.day ?? Infinity,
      a.hour ?? Infinity,
      a.minute ?? Infinity,
    ];
    const bv = [
      b.year ?? Infinity,
      b.month ?? Infinity,
      b.day ?? Infinity,
      b.hour ?? Infinity,
      b.minute ?? Infinity,
    ];
    for (let i = 0; i < av.length; i++) {
      if (av[i] !== bv[i]) return av[i] - bv[i];
    }
    return 0;
  });

  // Build table
  const header = `| title | year | month | day | hour | minute | location | characters | chapter |`;
  const separator = `|-------|------|-------|-----|------|--------|----------|------------|---------|`;
  const tableRows = events.map((ev) => {
    const location = ev.location ? wrapWikilink(ev.location) : "";
    const characters = ev.characters?.length
      ? ev.characters.map(wrapWikilink).join(", ")
      : "";
    const cols = [
      ev.title,
      ev.year !== undefined ? String(ev.year) : "",
      ev.month !== undefined ? String(ev.month) : "",
      ev.day !== undefined ? String(ev.day) : "",
      ev.hour !== undefined ? String(ev.hour) : "",
      ev.minute !== undefined ? String(ev.minute) : "",
      location,
      characters,
      ev.chapterLink ?? "",
    ];
    return `| ${cols.join(" | ")} |`;
  });

  const content = `# Timeline\n\n${header}\n${separator}\n${tableRows.join("\n")}\n`;

  try {
    if (vault.getAbstractFileByPath(timelinePath)) {
      await vault.adapter.write(timelinePath, content);
    } else {
      await vault.create(timelinePath, content);
    }
    new Notice("Timeline updated.");
  } catch (err) {
    new Notice(`Failed to update timeline: ${err}`);
  }
}

/** Wrap a string in [[]] if not already wrapped. */
function wrapWikilink(s: string): string {
  const trimmed = s.trim();
  if (trimmed.startsWith("[[") && trimmed.endsWith("]]")) return trimmed;
  return trimmed ? `[[${trimmed}]]` : "";
}

// ---------------------------------------------------------------------------
// Register context menu
// ---------------------------------------------------------------------------

/**
 * Register right-click context menu on editor:
 *   - "Send to chat"      — injects selection + file context into the chat panel
 *   - "Add to timeline"   — opens EventModal and updates timeline.md
 *   - "Assign character"  — wraps selection with [character: Name] —
 *
 * @param plugin         The Obsidian plugin instance (NarrativePlugin)
 * @param getCharacters  Function returning cached character list
 * @param activateChat   Function that opens the chat panel and returns the view
 */
export function registerContextMenu(
  plugin: Plugin,
  getCharacters: () => Character[],
  activateChat?: () => Promise<NarrativeChatView | null>
): void {
  plugin.registerEvent(
    plugin.app.workspace.on(
      "editor-menu",
      (menu: Menu, editor: Editor) => {
        // Only show when something is selected
        if (!editor.somethingSelected()) return;

        // ---------------------------------------------------------------
        // "Send to chat" item (always shown when there is a selection)
        // ---------------------------------------------------------------

        if (activateChat) {
          menu.addItem((item) =>
            item
              .setTitle("Send to chat")
              .setIcon("message-circle")
              .setSection("narrative")
              .onClick(async () => {
                const selection = editor.getSelection();
                if (!selection.trim()) return;

                const chatView = await activateChat();
                if (chatView) {
                  chatView.capturedSelection = selection;
                  chatView.injectMessage("Please analyze this selected passage.");
                } else {
                  new Notice("Could not open chat panel.");
                }
              })
          );
        }

        // ---------------------------------------------------------------
        // "Add to timeline" item
        // ---------------------------------------------------------------

        menu.addItem((item) =>
          item
            .setTitle("Add to timeline")
            .setIcon("clock")
            .setSection("narrative")
            .onClick(() => {
              void addTimelineEntry(plugin as NarrativePlugin, editor);
            })
        );

        // ---------------------------------------------------------------
        // "Assign character" item
        // ---------------------------------------------------------------

        const characters = getCharacters();
        if (characters.length === 0) return;

        if (characters.length <= 15) {
          // Short list: add inline submenu items
          menu.addItem((item) => {
            item
              .setTitle("Assign character")
              .setIcon("user")
              .setSection("narrative");

            // Obsidian doesn't support true submenus easily, so open a modal
            item.onClick(() => {
              new CharacterSuggestModal(
                plugin.app,
                characters,
                (char) => assignCharacterToSelection(editor, char)
              ).open();
            });
          });

          // Also add individual items for quick access (first 8)
          const shortList = characters.slice(0, 8);
          shortList.forEach((char) => {
            menu.addItem((item) =>
              item
                .setTitle(`  → ${char.name}`)
                .setIcon("message-square")
                .setSection("narrative-chars")
                .onClick(() => assignCharacterToSelection(editor, char))
            );
          });

          if (characters.length > 8) {
            menu.addItem((item) =>
              item
                .setTitle("  → More characters...")
                .setIcon("more-horizontal")
                .setSection("narrative-chars")
                .onClick(() => {
                  new CharacterSuggestModal(
                    plugin.app,
                    characters,
                    (char) => assignCharacterToSelection(editor, char)
                  ).open();
                })
            );
          }
        } else {
          // Long list: use modal
          menu.addItem((item) =>
            item
              .setTitle("Assign character...")
              .setIcon("user")
              .setSection("narrative")
              .onClick(() => {
                new CharacterSuggestModal(
                  plugin.app,
                  characters,
                  (char) => assignCharacterToSelection(editor, char)
                ).open();
              })
          );
        }
      }
    )
  );
}
