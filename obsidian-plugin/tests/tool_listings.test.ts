import { describe, it, expect } from "vitest";
import { LocalToolExecutor } from "../src/tools";
import { TFile, FileSystemAdapter } from "../tests/__mocks__/obsidian";

/**
 * Build an in-memory mock of the parts of `App` that LocalToolExecutor touches:
 * - vault.adapter (FileSystemAdapter so toVaultRelative falls through)
 * - vault.getFiles() — returns the registered TFile mocks
 * - vault.read(file) — returns content keyed by file.path
 * - vault.getAbstractFileByPath — returns the matching TFile
 */
function makeApp(files: Record<string, string>): any {
  const tfiles: TFile[] = Object.entries(files).map(([path, _content]) => {
    const t = new TFile();
    t.path = path;
    const name = path.split("/").pop() ?? path;
    t.name = name;
    t.basename = name.replace(/\.md$/, "");
    t.extension = name.endsWith(".md") ? "md" : "";
    return t;
  });

  const adapter = new FileSystemAdapter();
  return {
    vault: {
      adapter,
      getFiles: () => tfiles,
      read: async (file: TFile) => files[file.path] ?? "",
      getAbstractFileByPath: (p: string) => tfiles.find((t) => t.path === p) ?? null,
    },
  };
}

const FILES = {
  "chapters/01-arrival.md": [
    "---",
    "chapter: 1",
    "title: Arrival",
    "status: draft",
    "---",
    "location:: Ganymede Station",
    "timeline:: Day 1",
    "",
    "[character: Rey] — Where are we?",
    "[character: Freya] — Ganymede.",
    "Some narration.",
  ].join("\n"),
  "chapters/02-corridor.md": [
    "---",
    "chapter: 2",
    "title: Corridor",
    "status: revision",
    "---",
    "location:: Corridor B",
    "timeline:: Day 1, evening",
    "",
    "[character: Rey] — We need to move.",
    "[character: Rey] — Now.",
  ].join("\n"),
  "chapters/03-engine.md": [
    "---",
    "chapter: 3",
    "title: Engine Room",
    "---",
    "location:: Engine Room",
    "",
    "[character: Freya] — I can fix this.",
  ].join("\n"),
  "notes/world.md": "Some world notes — should NOT show up in chapter listings.",
};

describe("LocalToolExecutor — list_chapters", () => {
  const tools = new LocalToolExecutor(makeApp(FILES), "");

  it("returns one entry per chapter file with number, title, status", async () => {
    const out = await tools.list_chapters({});
    expect(out).toContain("Chapters (3)");
    expect(out).toContain("01-arrival.md — chapter 1: Arrival (draft)");
    expect(out).toContain("02-corridor.md — chapter 2: Corridor (revision)");
    expect(out).toContain("03-engine.md — chapter 3: Engine Room");
  });

  it("ignores files outside the chapters/ folder", async () => {
    const out = await tools.list_chapters({});
    expect(out).not.toContain("world.md");
  });
});

describe("LocalToolExecutor — list_characters", () => {
  const tools = new LocalToolExecutor(makeApp(FILES), "");

  it("counts dialogue lines per character across all chapters", async () => {
    const out = await tools.list_characters({});
    // Rey: 1 in arrival + 2 in corridor = 3 lines
    // Freya: 1 in arrival + 1 in engine = 2 lines
    expect(out).toContain("Rey — 3 dialogue lines");
    expect(out).toContain("Freya — 2 dialogue lines");
    // Sorted by frequency: Rey before Freya
    expect(out.indexOf("Rey")).toBeLessThan(out.indexOf("Freya"));
  });
});

describe("LocalToolExecutor — search_by_character", () => {
  const tools = new LocalToolExecutor(makeApp(FILES), "");

  it("finds scenes containing the named character", async () => {
    const out = await tools.search_by_character({ name: "Rey" });
    expect(out).toContain("01-arrival.md");
    expect(out).toContain("02-corridor.md");
    expect(out).not.toContain("03-engine.md");
  });

  it("is case-insensitive", async () => {
    const out = await tools.search_by_character({ name: "freya" });
    expect(out).toContain("01-arrival.md");
    expect(out).toContain("03-engine.md");
  });

  it("returns a not-found message when nobody matches", async () => {
    const out = await tools.search_by_character({ name: "Unknown" });
    expect(out).toMatch(/no scenes found/i);
  });

  it("rejects empty input", async () => {
    const out = await tools.search_by_character({ name: "" });
    expect(out).toMatch(/provide/i);
  });
});

describe("LocalToolExecutor — search_by_location", () => {
  const tools = new LocalToolExecutor(makeApp(FILES), "");

  it("matches by case-insensitive substring", async () => {
    const out = await tools.search_by_location({ location: "ganymede" });
    expect(out).toContain("01-arrival.md");
    expect(out).not.toContain("02-corridor.md");
  });

  it("returns not-found for unknown location", async () => {
    const out = await tools.search_by_location({ location: "Mars" });
    expect(out).toMatch(/no scenes found/i);
  });
});

describe("LocalToolExecutor — get_chapter", () => {
  const tools = new LocalToolExecutor(makeApp(FILES), "");

  it("returns chapter content with line numbers when number matches frontmatter", async () => {
    const out = await tools.get_chapter({ chapter_number: 2 });
    expect(out).toContain("[Chapter 2 — 02-corridor.md]");
    expect(out).toMatch(/\d+: ---/);
    expect(out).toContain("location:: Corridor B");
  });

  it("returns not-found message for a missing chapter number", async () => {
    const out = await tools.get_chapter({ chapter_number: 99 });
    expect(out).toMatch(/no chapter with number 99/i);
  });

  it("rejects non-numeric input", async () => {
    const out = await tools.get_chapter({ chapter_number: NaN });
    expect(out).toMatch(/provide a numeric/i);
  });
});
