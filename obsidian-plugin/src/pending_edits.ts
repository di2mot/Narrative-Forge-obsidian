import { App, TFile, MarkdownView } from "obsidian";

export type PendingEditKind = "replace" | "append" | "create-file";

export interface PendingEdit {
  id: string;
  filePath: string;
  kind: PendingEditKind;
  oldText: string;
  newText: string;
  range?: { startLine: number; startChar: number; endLine: number; endChar: number };
}

export class PendingEditsRegistry {
  private byFile = new Map<string, PendingEdit[]>();
  private resolvers = new Map<string, (status: "applied" | "rejected") => void>();
  private listeners = new Set<(filePath: string) => void>();

  propose(edit: PendingEdit, resolve: (status: "applied" | "rejected") => void): void {
    const list = this.byFile.get(edit.filePath) ?? [];
    list.push(edit);
    this.byFile.set(edit.filePath, list);
    this.resolvers.set(edit.id, resolve);
    this.notify(edit.filePath);
  }

  forFile(filePath: string): PendingEdit[] {
    return this.byFile.get(filePath) ?? [];
  }

  resolve(id: string, status: "applied" | "rejected"): void {
    const resolver = this.resolvers.get(id);
    if (!resolver) return;
    let filePath: string | undefined;
    for (const [fp, edits] of this.byFile.entries()) {
      const idx = edits.findIndex((e) => e.id === id);
      if (idx !== -1) {
        filePath = fp;
        edits.splice(idx, 1);
        if (edits.length === 0) this.byFile.delete(fp);
        break;
      }
    }
    this.resolvers.delete(id);
    resolver(status);
    if (filePath) this.notify(filePath);
  }

  resolveAll(filePath: string, status: "applied" | "rejected"): void {
    const edits = this.byFile.get(filePath);
    if (!edits) return;
    const ids = edits.map((e) => e.id);
    for (const id of ids) this.resolve(id, status);
  }

  onChange(listener: (filePath: string) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  private notify(filePath: string): void {
    for (const l of this.listeners) l(filePath);
  }
}

export async function proposeWrite(
  app: App,
  registry: PendingEditsRegistry,
  edit: Omit<PendingEdit, "id">
): Promise<"applied" | "rejected"> {
  const id = crypto.randomUUID();
  const fullEdit: PendingEdit = { ...edit, id };

  const file = app.vault.getAbstractFileByPath(edit.filePath);
  if (file instanceof TFile) {
    const existingLeaf = app.workspace
      .getLeavesOfType("markdown")
      .find((l) => (l.view as MarkdownView).file?.path === edit.filePath);
    if (existingLeaf) {
      app.workspace.revealLeaf(existingLeaf);
    } else {
      const leaf = app.workspace.getLeaf("tab");
      await leaf.openFile(file);
    }
  }

  return new Promise<"applied" | "rejected">((resolve) => {
    registry.propose(fullEdit, resolve);
  });
}
