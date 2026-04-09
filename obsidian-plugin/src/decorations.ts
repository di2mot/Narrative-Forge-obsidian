/**
 * CodeMirror 6 decorations for .nos / .md files in Obsidian.
 *
 * Features:
 * - Hides [character: Name] — prefix, shows only a styled "— " dash widget
 * - Underlines dialogue text in character color with hover tooltip
 * - Hides [key: value] metadata tags when cursor is not on that line
 */

import {
  Extension,
  RangeSetBuilder,
} from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";

// ---------------------------------------------------------------------------
// Color utility
// ---------------------------------------------------------------------------

/**
 * Deterministic HSL color from a character name string.
 */
export function charColor(name: string, alpha = 0.45): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash) % 360;
  return `hsla(${h}, 45%, 55%, ${alpha})`;
}

/**
 * Solid version of the character color (for underlines etc.)
 */
export function charColorSolid(name: string): string {
  let hash = 0;
  for (let i = 0; i < name.length; i++) {
    hash = name.charCodeAt(i) + ((hash << 5) - hash);
  }
  const h = Math.abs(hash) % 360;
  return `hsl(${h}, 45%, 45%)`;
}

// ---------------------------------------------------------------------------
// Widget: em dash prefix replacing [character: Name] —
// ---------------------------------------------------------------------------

class DashWidget extends WidgetType {
  constructor(
    readonly charName: string,
    readonly color: string
  ) {
    super();
  }

  toDOM(): HTMLElement {
    const span = document.createElement("span");
    span.className = "narrative-dash-widget";
    span.textContent = "— ";
    span.style.color = this.color;
    span.style.userSelect = "none";
    span.style.fontWeight = "bold";
    span.dataset["char"] = this.charName;
    span.title = this.charName;
    return span;
  }

  eq(other: DashWidget): boolean {
    return other.charName === this.charName && other.color === this.color;
  }

  ignoreEvent(): boolean {
    return false;
  }
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

// Matches: [character: Name] — or – or - (with optional spaces before dash)
// Handles em dash —, en dash –, and regular dash -
const DIALOGUE_PATTERN = /^\[character:\s*([^\]]+)\]\s*[—–-]\s*/;

// Matches metadata-only lines: [key: value] [key2: value2] ...
// Must NOT start with a character dialogue pattern
const METADATA_PATTERN = /^\[[\w\s-]+:[^\]]+\](\s+\[[\w\s-]+:[^\]]+\])*/;

// ---------------------------------------------------------------------------
// Build decorations from visible ranges
// ---------------------------------------------------------------------------

function buildDecorations(
  view: EditorView,
  colorMap: Record<string, string>,
  defaultColors: Map<string, string>
): DecorationSet {
  const builder = new RangeSetBuilder<Decoration>();
  const { state } = view;

  // Get cursor line numbers to skip raw hiding on cursor line
  const cursorLines = new Set<number>();
  for (const range of state.selection.ranges) {
    const line = state.doc.lineAt(range.head);
    cursorLines.add(line.number);
  }

  for (const { from, to } of view.visibleRanges) {
    let pos = from;

    while (pos <= to) {
      const line = state.doc.lineAt(pos);
      const lineText = line.text;
      const onCursorLine = cursorLines.has(line.number);

      // --- Dialogue lines ---
      const dialogueMatch = DIALOGUE_PATTERN.exec(lineText);
      if (dialogueMatch) {
        const charName = dialogueMatch[1].trim();
        const prefixLen = dialogueMatch[0].length;

        // Resolve color: first from API color map, then deterministic
        const charColorMapEntry = (colorMap["character"] as unknown) as Record<string, string> | undefined;
        const color =
          charColorMapEntry?.[charName] ||
          defaultColors.get(charName) ||
          charColorSolid(charName);

        // Store in defaultColors cache for this name
        if (!defaultColors.has(charName)) {
          defaultColors.set(charName, charColorSolid(charName));
        }

        if (!onCursorLine) {
          // Hide [character: Name] — with DashWidget
          builder.add(
            line.from,
            line.from + prefixLen,
            Decoration.replace({
              widget: new DashWidget(charName, color),
            })
          );

          // Mark dialogue text with underline
          const dialogueFrom = line.from + prefixLen;
          const dialogueTo = line.to;
          if (dialogueFrom < dialogueTo) {
            builder.add(
              dialogueFrom,
              dialogueTo,
              Decoration.mark({
                class: "narrative-dialogue",
                attributes: {
                  style: `border-bottom: 2px solid ${color}; text-decoration: none;`,
                  "data-char": charName,
                  title: charName,
                },
              })
            );
          }
        }
        // If on cursor line: show raw text (no decorations)

        pos = line.to + 1;
        continue;
      }

      // --- Metadata-only lines (hide when not on cursor) ---
      if (!onCursorLine && METADATA_PATTERN.test(lineText)) {
        // Only hide if the line consists ONLY of metadata tags (no dialogue)
        const stripped = lineText.replace(/\[[\w\s-]+:[^\]]+\]\s*/g, "").trim();
        if (stripped.length === 0 && lineText.trim().length > 0) {
          builder.add(
            line.from,
            line.to,
            Decoration.mark({
              class: "narrative-metadata-hidden",
            })
          );
        }
      }

      pos = line.to + 1;
    }
  }

  return builder.finish();
}

// ---------------------------------------------------------------------------
// ViewPlugin factory
// ---------------------------------------------------------------------------

/**
 * Returns a CM6 Extension array wrapping the narrative-os view plugin.
 * Use this with plugin.registerEditorExtension(buildNosPlugin(colors)).
 */
export function buildNosPlugin(
  colors: Record<string, unknown>
): Extension {
  return [buildNosDecorations(colors as Record<string, Record<string, string>>)];
}

/**
 * Returns a CM6 Extension that adds narrative-os decorations to the editor.
 * @param colorMap  Color map from /api/colors, e.g. { character: { Artur: "#..." } }
 */
export function buildNosDecorations(
  colorMap: Record<string, Record<string, string>>
): Extension {
  const charColorMap = colorMap["character"] || {};
  const defaultColors = new Map<string, string>();

  // Hover tooltip management
  let tooltipEl: HTMLElement | null = null;

  const plugin = ViewPlugin.fromClass(
    class {
      decorations: DecorationSet;
      private hoverListener: ((e: MouseEvent) => void) | null = null;
      private leaveListener: ((e: MouseEvent) => void) | null = null;
      private editorDom: HTMLElement | null = null;

      constructor(view: EditorView) {
        this.decorations = buildDecorations(view, charColorMap, defaultColors);
        this.attachHoverListeners(view);
      }

      update(update: ViewUpdate) {
        if (
          update.docChanged ||
          update.viewportChanged ||
          update.selectionSet
        ) {
          this.decorations = buildDecorations(
            update.view,
            charColorMap,
            defaultColors
          );
        }
      }

      destroy() {
        this.removeHoverListeners();
        this.hideTooltip();
      }

      private attachHoverListeners(view: EditorView) {
        this.editorDom = view.dom;

        this.hoverListener = (e: MouseEvent) => {
          const target = e.target as HTMLElement;
          // Check data-char on the element or a parent
          const charEl = target.closest<HTMLElement>("[data-char]");
          if (charEl) {
            const charName = charEl.dataset["char"];
            if (charName) this.showTooltip(charName, e.clientX, e.clientY);
          } else {
            this.hideTooltip();
          }
        };

        this.leaveListener = () => {
          this.hideTooltip();
        };

        this.editorDom.addEventListener("mousemove", this.hoverListener);
        this.editorDom.addEventListener("mouseleave", this.leaveListener);
      }

      private removeHoverListeners() {
        if (!this.editorDom) return;
        if (this.hoverListener) {
          this.editorDom.removeEventListener("mousemove", this.hoverListener);
        }
        if (this.leaveListener) {
          this.editorDom.removeEventListener("mouseleave", this.leaveListener);
        }
      }

      private showTooltip(name: string, x: number, y: number) {
        if (!tooltipEl) {
          tooltipEl = document.createElement("div");
          tooltipEl.className = "narrative-hover-tooltip";
          document.body.appendChild(tooltipEl);
        }
        tooltipEl.textContent = `Character: ${name}`;
        tooltipEl.style.left = `${x + 12}px`;
        tooltipEl.style.top = `${y - 30}px`;
        tooltipEl.style.display = "block";
      }

      private hideTooltip() {
        if (tooltipEl) {
          tooltipEl.style.display = "none";
        }
      }
    },
    {
      decorations: (v) => v.decorations,
    }
  );

  return plugin;
}
