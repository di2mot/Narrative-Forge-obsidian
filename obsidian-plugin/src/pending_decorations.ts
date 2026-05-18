import { App, MarkdownView } from "obsidian";
import { Extension, StateEffect, RangeSetBuilder } from "@codemirror/state";
import {
  Decoration,
  DecorationSet,
  EditorView,
  ViewPlugin,
  ViewUpdate,
  WidgetType,
} from "@codemirror/view";
import { PendingEditsRegistry, PendingEdit } from "./pending_edits";

const forceUpdate = StateEffect.define<null>();

class InsertWidget extends WidgetType {
  constructor(readonly text: string) {
    super();
  }
  eq(other: InsertWidget) {
    return other.text === this.text;
  }
  toDOM() {
    const span = document.createElement("span");
    span.className = "nf-pending-insert";
    span.textContent = this.text;
    return span;
  }
  ignoreEvent() {
    return false;
  }
}

class ActionsWidget extends WidgetType {
  constructor(
    readonly id: string,
    readonly registry: PendingEditsRegistry,
    readonly filePath: string
  ) {
    super();
  }
  eq(other: ActionsWidget) {
    return other.id === this.id;
  }
  toDOM() {
    const wrap = document.createElement("span");
    wrap.className = "nf-pending-actions";

    const apply = document.createElement("button");
    apply.className = "nf-pending-button nf-pending-apply";
    apply.textContent = "Apply";
    apply.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.registry.resolve(this.id, "applied");
    });

    const reject = document.createElement("button");
    reject.className = "nf-pending-button nf-pending-reject";
    reject.textContent = "Reject";
    reject.addEventListener("mousedown", (e) => {
      e.preventDefault();
      e.stopPropagation();
      this.registry.resolve(this.id, "rejected");
    });

    wrap.appendChild(apply);
    wrap.appendChild(reject);
    return wrap;
  }
  ignoreEvent() {
    return false;
  }
}

export function buildPendingEditsPlugin(
  app: App,
  registry: PendingEditsRegistry
): Extension {
  return ViewPlugin.fromClass(
    class {
      decorations: DecorationSet = Decoration.none;
      private unsubscribe: (() => void) | null = null;
      private scrollbarOverlay: HTMLElement | null = null;
      private banner: HTMLElement | null = null;
      private filePath: string | null = null;

      constructor(private view: EditorView) {
        this.filePath = this.resolveFilePath();
        this.unsubscribe = registry.onChange((fp) => {
          if (fp !== this.filePath) return;
          this.view.dispatch({ effects: forceUpdate.of(null) });
        });
        this.rebuild();
        this.updateDOM();
      }

      update(update: ViewUpdate) {
        if (!this.filePath) this.filePath = this.resolveFilePath();
        const triggered = update.transactions.some((tr) =>
          tr.effects.some((e) => e.is(forceUpdate))
        );
        if (triggered || update.docChanged || update.viewportChanged) {
          this.rebuild();
          this.updateDOM();
        }
      }

      destroy() {
        if (this.unsubscribe) this.unsubscribe();
        this.scrollbarOverlay?.remove();
        this.banner?.remove();
      }

      private resolveFilePath(): string | null {
        for (const leaf of app.workspace.getLeavesOfType("markdown")) {
          const mdv = leaf.view as MarkdownView;
          if ((mdv.editor as any)?.cm === this.view) {
            return mdv.file?.path ?? null;
          }
        }
        return null;
      }

      private rebuild() {
        const edits = this.filePath ? registry.forFile(this.filePath) : [];
        if (edits.length === 0) {
          this.decorations = Decoration.none;
          return;
        }

        const doc = this.view.state.doc;

        // Collect [from, to, decoration] tuples then sort by from
        const items: Array<[number, number, Decoration]> = [];

        for (const edit of edits) {
          if (edit.kind === "replace" && edit.range) {
            const { startLine, startChar, endLine, endChar } = edit.range;
            const sl = doc.line(Math.max(1, Math.min(startLine, doc.lines)));
            const el = doc.line(Math.max(1, Math.min(endLine, doc.lines)));
            const from = Math.min(sl.from + startChar, sl.to);
            const to = Math.min(el.from + endChar, el.to);

            if (from < to) {
              items.push([from, to, Decoration.mark({ class: "nf-pending-delete" })]);
            }
            const insertPos = Math.max(from, to);
            items.push([
              insertPos,
              insertPos,
              Decoration.widget({ widget: new InsertWidget(edit.newText), side: 1 }),
            ]);
            items.push([
              insertPos,
              insertPos,
              Decoration.widget({
                widget: new ActionsWidget(edit.id, registry, this.filePath!),
                side: 1,
              }),
            ]);
          } else if (edit.kind === "append") {
            const pos = doc.length;
            items.push([
              pos,
              pos,
              Decoration.widget({
                widget: new InsertWidget("\n\n" + edit.newText),
                side: 1,
              }),
            ]);
            items.push([
              pos,
              pos,
              Decoration.widget({
                widget: new ActionsWidget(edit.id, registry, this.filePath!),
                side: 1,
              }),
            ]);
          } else if (edit.kind === "create-file") {
            if (doc.length > 0) {
              items.push([0, doc.length, Decoration.mark({ class: "nf-pending-create" })]);
            }
            items.push([
              0,
              0,
              Decoration.widget({
                widget: new ActionsWidget(edit.id, registry, this.filePath!),
                side: -1,
              }),
            ]);
          }
        }

        // Sort by from, then by length descending (marks before widgets at same pos)
        items.sort((a, b) => a[0] - b[0] || (b[1] - b[0]) - (a[1] - a[0]));

        const builder = new RangeSetBuilder<Decoration>();
        for (const [from, to, deco] of items) {
          try {
            builder.add(from, to, deco);
          } catch {
            // skip invalid range
          }
        }

        try {
          this.decorations = builder.finish();
        } catch {
          this.decorations = Decoration.none;
        }
      }

      private updateDOM() {
        const edits = this.filePath ? registry.forFile(this.filePath) : [];
        this.updateScrollbar(edits);
        this.updateBanner(edits);
      }

      private updateScrollbar(edits: PendingEdit[]) {
        if (!this.scrollbarOverlay) {
          this.scrollbarOverlay = document.createElement("div");
          this.scrollbarOverlay.className = "nf-pending-scrollbar-overlay";
          this.view.scrollDOM.appendChild(this.scrollbarOverlay);
        }
        this.scrollbarOverlay.empty();
        if (edits.length === 0) return;

        const docLines = Math.max(this.view.state.doc.lines, 1);
        for (const edit of edits) {
          const stripe = document.createElement("div");
          stripe.className = "nf-pending-scrollbar-marker";
          if (edit.kind === "replace" && edit.range) {
            const pct = ((edit.range.startLine - 1) / docLines) * 100;
            stripe.style.top = `${Math.min(pct, 92)}%`;
          } else {
            stripe.style.top = "94%";
          }
          this.scrollbarOverlay.appendChild(stripe);
        }
      }

      private updateBanner(edits: PendingEdit[]) {
        if (edits.length === 0) {
          this.banner?.remove();
          this.banner = null;
          return;
        }

        if (!this.banner) {
          this.banner = document.createElement("div");
          this.banner.className = "nf-pending-banner";
          this.view.dom.insertBefore(this.banner, this.view.scrollDOM);
        }

        this.banner.empty();

        const label = document.createElement("span");
        label.className = "nf-pending-banner-label";
        label.textContent = `${edits.length} pending AI edit${edits.length > 1 ? "s" : ""}`;

        const applyAll = document.createElement("button");
        applyAll.className = "nf-pending-button nf-pending-apply";
        applyAll.textContent = "Apply All";
        applyAll.addEventListener("mousedown", (e) => {
          e.preventDefault();
          if (this.filePath) registry.resolveAll(this.filePath, "applied");
        });

        const rejectAll = document.createElement("button");
        rejectAll.className = "nf-pending-button nf-pending-reject";
        rejectAll.textContent = "Reject All";
        rejectAll.addEventListener("mousedown", (e) => {
          e.preventDefault();
          if (this.filePath) registry.resolveAll(this.filePath, "rejected");
        });

        this.banner.appendChild(label);
        this.banner.appendChild(applyAll);
        this.banner.appendChild(rejectAll);
      }
    },
    {
      decorations: (v) => v.decorations,
    }
  );
}
