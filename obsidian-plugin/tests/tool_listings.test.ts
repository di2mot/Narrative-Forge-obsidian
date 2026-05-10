import { describe, it, expect } from "vitest";
import { LocalToolExecutor } from "../src/tools";
import { TFile, FileSystemAdapter } from "../tests/__mocks__/obsidian";

/**
 * Build an in-memory mock of the parts of `App` that LocalToolExecutor touches:
 * - vault.adapter (FileSystemAdapter so toVaultRelative falls through)
 * - vault.getFiles() — returns the registered TFile mocks
 * - vault.read(file) — returns content keyed by file.path
 * - vault.getAbstractFileByPath — returns the matching TFile
 *
 * The mock vectorDb (tests/__mocks__/database.ts) returns empty for every
 * method, so the hybrid tools always fall through to the file-scan branch.
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
  // Pure-narrative chapter — no dialogue tags, but characters in frontmatter.
  // The user-reported bug: list_characters used to miss Trond and Sam here.
  "chapters/04-prologue.md": [
    "---",
    "chapter: 4",
    "title: Prologue",
    "characters: [Trond, Sam]",
    "---",
    "Trond and Sam stood at the dock. Neither said a word.",
  ].join("\n"),
  "notes/world.md": "Some world notes — should NOT show up in chapter listings.",
  "characters/Рей Нансен.md": [
    "---",
    "type: character",
    "full_name: Рей Нансен",
    "aliases: [Rey, Рей]",
    "role: protagonist",
    "status: alive",
    "---",
    "Рей — головний герой. Прибув на Ганімед у Рік 1.",
  ].join("\n"),
  "locations/Ганімед.md": [
    "---",
    "type: location",
    "full_name: Ганімед",
    "aliases: [Ganymede, Ганімед Станція]",
    "location_type: space station",
    "---",
    "Великий супутник Юпітера. Штаб-квартира дії.",
  ].join("\n"),
};

describe("LocalToolExecutor — list_chapters (hybrid → file scan)", () => {
  const tools = new LocalToolExecutor(makeApp(FILES), "");

  it("returns one entry per chapter file with number, title, status", async () => {
    const out = await tools.list_chapters({});
    expect(out).toContain("file scan");
    expect(out).toContain("01-arrival.md — chapter 1: Arrival (draft)");
    expect(out).toContain("02-corridor.md — chapter 2: Corridor (revision)");
    expect(out).toContain("03-engine.md — chapter 3: Engine Room");
    expect(out).toContain("04-prologue.md — chapter 4: Prologue");
  });

  it("ignores files outside the chapters/ folder", async () => {
    const out = await tools.list_chapters({});
    expect(out).not.toContain("world.md");
  });
});

describe("LocalToolExecutor — list_characters (hybrid → file scan)", () => {
  const tools = new LocalToolExecutor(makeApp(FILES), "");

  it("includes characters from `[character: Name]` dialogue tags", async () => {
    const out = await tools.list_characters({});
    expect(out).toContain("Rey");
    expect(out).toContain("Freya");
  });

  it("includes characters from frontmatter `characters: [Name1, Name2]` even when no dialogue tags exist", async () => {
    const out = await tools.list_characters({});
    // Bug fix: 04-prologue.md has no dialogue but lists Trond and Sam in
    // frontmatter. They must show up.
    expect(out).toContain("Trond");
    expect(out).toContain("Sam");
  });
});

describe("LocalToolExecutor — search_by_character (hybrid → file scan)", () => {
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

  it("finds characters from frontmatter `characters:` even when no dialogue", async () => {
    const out = await tools.search_by_character({ name: "Trond" });
    expect(out).toContain("04-prologue.md");
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

describe("LocalToolExecutor — search_by_location (hybrid → file scan)", () => {
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

describe("LocalToolExecutor — get_chapter (hybrid → file scan)", () => {
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

describe("LocalToolExecutor — list_characters profile markers", () => {
  const tools = new LocalToolExecutor(makeApp(FILES), "");

  it("includes Рей Нансен with 'profile' marker from characters/", async () => {
    const out = await tools.list_characters({});
    expect(out).toContain("Рей Нансен");
    expect(out).toMatch(/Рей Нансен.*profile/);
  });
});

describe("LocalToolExecutor — search_by_character alias matching", () => {
  const tools = new LocalToolExecutor(makeApp(FILES), "");

  it("finds the profile via alias 'Rey' and prepends a Profile notice", async () => {
    const out = await tools.search_by_character({ name: "Rey" });
    expect(out).toMatch(/Profile:/i);
    expect(out).toContain("Рей Нансен.md");
    expect(out).toContain("read_note");
  });
});

describe("LocalToolExecutor — list_locations", () => {
  const tools = new LocalToolExecutor(makeApp(FILES), "");

  it("includes Ганімед from the locations/ profile", async () => {
    const out = await tools.list_locations({});
    expect(out).toContain("Ганімед");
  });

  it("includes chapter-derived locations", async () => {
    const out = await tools.list_locations({});
    expect(out).toContain("Ganymede Station");
    expect(out).toContain("Corridor B");
  });

  it("marks Ганімед with 'profile'", async () => {
    const out = await tools.list_locations({});
    expect(out).toMatch(/Ганімед.*profile/);
  });
});

describe("LocalToolExecutor — read_note resolves across subfolders", () => {
  const tools = new LocalToolExecutor(makeApp(FILES), "");

  it("resolves a file in locations/ by bare filename", async () => {
    const out = await tools.read_note({ filename: "Ганімед.md" });
    expect(out).toContain("Великий супутник Юпітера");
    expect(out).toMatch(/^\s*1:/m);
  });

  it("resolves a file in characters/ by bare filename", async () => {
    const out = await tools.read_note({ filename: "Рей Нансен.md" });
    expect(out).toContain("головний герой");
  });

  it("returns not-found for a missing file", async () => {
    const out = await tools.read_note({ filename: "nobody.md" });
    expect(out).toMatch(/file not found/i);
  });
});

// Note: the DB-first branch of the hybrid tools is exercised end-to-end
// inside Obsidian after a real import; here we only test the file-scan
// fallback (mocked vectorDb returns empty so the fallback is taken).
