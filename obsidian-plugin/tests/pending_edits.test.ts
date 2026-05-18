import { describe, it, expect, vi } from "vitest";
import { PendingEditsRegistry, PendingEdit } from "../src/pending_edits";

function makeEdit(overrides: Partial<PendingEdit> = {}): PendingEdit {
  return {
    id: "test-id",
    filePath: "chapters/ch1.md",
    kind: "replace",
    oldText: "old",
    newText: "new",
    ...overrides,
  };
}

describe("PendingEditsRegistry", () => {
  it("propose() adds the edit, stores a resolver, and fires the listener", () => {
    const reg = new PendingEditsRegistry();
    const listener = vi.fn();
    reg.onChange(listener);

    const edit = makeEdit();
    const resolve = vi.fn();
    reg.propose(edit, resolve);

    expect(reg.forFile("chapters/ch1.md")).toHaveLength(1);
    expect(reg.forFile("chapters/ch1.md")[0].id).toBe("test-id");
    expect(listener).toHaveBeenCalledWith("chapters/ch1.md");
    expect(resolve).not.toHaveBeenCalled();
  });

  it('resolve(id, "applied") removes the edit, calls resolver with "applied", fires listener', () => {
    const reg = new PendingEditsRegistry();
    const listener = vi.fn();
    reg.onChange(listener);

    const edit = makeEdit();
    const resolve = vi.fn();
    reg.propose(edit, resolve);
    listener.mockClear();

    reg.resolve("test-id", "applied");

    expect(reg.forFile("chapters/ch1.md")).toHaveLength(0);
    expect(resolve).toHaveBeenCalledWith("applied");
    expect(listener).toHaveBeenCalledWith("chapters/ch1.md");
  });

  it('resolve(id, "rejected") removes the edit, calls resolver with "rejected", fires listener', () => {
    const reg = new PendingEditsRegistry();
    const edit = makeEdit();
    const resolve = vi.fn();
    reg.propose(edit, resolve);

    reg.resolve("test-id", "rejected");

    expect(reg.forFile("chapters/ch1.md")).toHaveLength(0);
    expect(resolve).toHaveBeenCalledWith("rejected");
  });

  it('resolveAll(filePath, "applied") resolves every edit for that file', () => {
    const reg = new PendingEditsRegistry();
    const r1 = vi.fn();
    const r2 = vi.fn();
    reg.propose(makeEdit({ id: "id-1" }), r1);
    reg.propose(makeEdit({ id: "id-2" }), r2);

    reg.resolveAll("chapters/ch1.md", "applied");

    expect(reg.forFile("chapters/ch1.md")).toHaveLength(0);
    expect(r1).toHaveBeenCalledWith("applied");
    expect(r2).toHaveBeenCalledWith("applied");
  });

  it("resolving an unknown id is a no-op (no throw)", () => {
    const reg = new PendingEditsRegistry();
    expect(() => reg.resolve("nonexistent", "applied")).not.toThrow();
  });

  it("forFile() returns [] for an unknown path", () => {
    const reg = new PendingEditsRegistry();
    expect(reg.forFile("chapters/unknown.md")).toEqual([]);
  });
});
