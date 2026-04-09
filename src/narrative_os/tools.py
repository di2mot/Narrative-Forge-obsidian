"""Tool definitions and dispatcher for narrative-os AI agent."""

from __future__ import annotations
import os
from pathlib import Path


BOOK_DIR = Path(os.environ.get("NOS_BOOK_DIR", "."))


TOOL_DEFINITIONS = [
    {
        "name": "search_semantic",
        "description": "Semantic similarity search over all scenes and dialogue in the book. Use this to find scenes related to a concept, emotion, or event.",
        "input_schema": {
            "type": "object",
            "properties": {
                "query": {"type": "string", "description": "Natural language query"},
                "n": {"type": "integer", "description": "Number of results (default 5)", "default": 5},
            },
            "required": ["query"],
        },
    },
    {
        "name": "search_by_character",
        "description": "Find all scenes featuring a specific character.",
        "input_schema": {
            "type": "object",
            "properties": {
                "name": {"type": "string", "description": "Character name"},
                "n": {"type": "integer", "description": "Max results (default 20)", "default": 20},
            },
            "required": ["name"],
        },
    },
    {
        "name": "search_by_location",
        "description": "Find all scenes set in a specific location.",
        "input_schema": {
            "type": "object",
            "properties": {
                "location": {"type": "string", "description": "Location name"},
                "n": {"type": "integer", "description": "Max results (default 20)", "default": 20},
            },
            "required": ["location"],
        },
    },
    {
        "name": "get_chapter",
        "description": "Get all scenes from a specific chapter.",
        "input_schema": {
            "type": "object",
            "properties": {
                "chapter_number": {"type": "integer", "description": "Chapter number"},
            },
            "required": ["chapter_number"],
        },
    },
    {
        "name": "list_chapters",
        "description": "List all indexed chapters with their titles.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "list_characters",
        "description": "List all unique character names found in the book.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "get_book_info",
        "description": "Get general information about the book (title, language, chapter count, character count).",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "read_scene",
        "description": "Read the raw text of a specific scene from a chapter file. Use this to get the exact text before editing.",
        "input_schema": {
            "type": "object",
            "properties": {
                "filename": {"type": "string", "description": "Chapter filename e.g. '01-siege.md'"},
                "scene_index": {"type": "integer", "description": "Scene index (0-based)"},
            },
            "required": ["filename", "scene_index"],
        },
    },
    {
        "name": "read_chapter",
        "description": "Read the full raw text of a chapter file.",
        "input_schema": {
            "type": "object",
            "properties": {
                "filename": {"type": "string", "description": "Chapter filename e.g. '01-siege.md'"},
            },
            "required": ["filename"],
        },
    },
    {
        "name": "edit_scene",
        "description": "Edit a specific scene in a chapter file by replacing exact text. The old_text must match exactly what is in the file.",
        "input_schema": {
            "type": "object",
            "properties": {
                "filename": {"type": "string", "description": "Chapter filename"},
                "old_text": {"type": "string", "description": "The exact text to replace"},
                "new_text": {"type": "string", "description": "The replacement text"},
            },
            "required": ["filename", "old_text", "new_text"],
        },
    },
    {
        "name": "append_to_chapter",
        "description": "Append text to the end of a chapter file.",
        "input_schema": {
            "type": "object",
            "properties": {
                "filename": {"type": "string", "description": "Chapter filename"},
                "text": {"type": "string", "description": "Text to append"},
            },
            "required": ["filename", "text"],
        },
    },
    {
        "name": "reimport_book",
        "description": "Re-index the entire book into the vector database. Use this after the author has made manual edits to chapter files, or when search results seem outdated.",
        "input_schema": {"type": "object", "properties": {}},
    },
    {
        "name": "write_scene",
        "description": (
            "Write a new scene or dialogue passage and append it to a chapter file. "
            "Automatically formats dialogue lines as '[character: Name] — text'. "
            "Use this when the author asks to write new content. "
            "Pass raw prose — dialogue lines will be detected and formatted automatically."
        ),
        "input_schema": {
            "type": "object",
            "properties": {
                "filename": {"type": "string", "description": "Chapter filename to append to"},
                "text": {"type": "string", "description": "The scene text. For dialogue lines use format: 'Name: text' or '[character: Name] — text'"},
                "location": {"type": "string", "description": "Location for this scene (optional — adds scene break metadata)"},
                "timeline": {"type": "string", "description": "Timeline for this scene (optional)"},
            },
            "required": ["filename", "text"],
        },
    },
]


def _resolve_file(BD: Path, filename: str) -> Path | None:
    """Find a file by name across all known book subfolders.

    Supports:
    - bare name: "01-arrival.md" → searches chapters/, notes/, BD/
    - relative path: "notes/general.md" → resolves directly from BD
    """
    # If filename contains a slash, treat as relative to BD
    if "/" in filename:
        p = BD / filename
        return p if p.exists() else None

    # Bare filename — try common subdirs in order
    for subdir in ("chapters", "notes", ""):
        p = BD / subdir / filename if subdir else BD / filename
        if p.exists():
            return p
    return None


def _dispatch(name: str, inputs: dict, book_dir: Path | None = None) -> str:
    from . import search as search_mod

    BD = book_dir if book_dir is not None else BOOK_DIR

    if name == "search_semantic":
        results = search_mod.search_semantic(BD, inputs["query"], n=inputs.get("n", 5))
        if not results:
            return "No results found."
        lines = []
        for r in results:
            m = r["metadata"]
            chunk_info = ""
            if m.get("chunk_total", 1) > 1:
                chunk_info = f" [chunk {m.get('chunk_index', 0)+1}/{m.get('chunk_total')}]"
            lines.append(
                f"[Ch.{m.get('chapter')} -- {m.get('location', '?')} -- {m.get('timeline', '')}]{chunk_info}\n"
                f"Score: {r['score']:.2f}\n{r['text'][:500]}\n"
                f"→ To read full scene: read_scene(filename='{m.get('filename', '')}', scene_index={m.get('scene_index', 0)})"
            )
        return "\n\n---\n\n".join(lines)

    elif name == "search_by_character":
        results = search_mod.search_by_character(BD, inputs["name"], n=inputs.get("n", 20))
        if not results:
            return f"No scenes found with character '{inputs['name']}'."
        lines = []
        for r in results:
            m = r["metadata"]
            lines.append(f"[Ch.{m.get('chapter')} -- {m.get('location', '?')}]\n{r['text'][:400]}")
        return "\n\n---\n\n".join(lines)

    elif name == "search_by_location":
        results = search_mod.search_by_location(BD, inputs["location"], n=inputs.get("n", 20))
        if not results:
            return f"No scenes found at location '{inputs['location']}'."
        lines = []
        for r in results:
            m = r["metadata"]
            lines.append(f"[Ch.{m.get('chapter')} -- {m.get('timeline', '?')}]\n{r['text'][:400]}")
        return "\n\n---\n\n".join(lines)

    elif name == "get_chapter":
        results = search_mod.get_chapter_scenes(BD, inputs["chapter_number"])
        if not results:
            return f"Chapter {inputs['chapter_number']} not found or not indexed."
        lines = []
        for r in results:
            m = r["metadata"]
            lines.append(f"[Scene {m.get('scene_index', 0)} -- {m.get('location', '?')} -- {m.get('timeline', '')}]\n{r['text']}")
        return "\n\n---\n\n".join(lines)

    elif name == "list_chapters":
        chapters = search_mod.list_chapters(BD)
        if not chapters:
            return "No chapters indexed. Run import first."
        return "\n".join(f"Ch.{c['chapter']}: {c['title']} ({c['filename']})" for c in chapters)

    elif name == "list_characters":
        chars = search_mod.list_characters(BD)
        if not chars:
            return "No characters found. Run import first."
        return ", ".join(chars)

    elif name == "get_book_info":
        chapters = search_mod.list_chapters(BD)
        chars = search_mod.list_characters(BD)
        lang = os.environ.get("NOS_LANGUAGE", "en")
        if not chapters:
            return (
                f"Book directory: {BD}\n"
                f"No chapters indexed yet. The author needs to click 'Import' in the Narrative Forge sidebar "
                f"to index the book into the vector database before search and read tools will work."
            )
        return (
            f"Book directory: {BD}\n"
            f"Language: {lang}\n"
            f"Chapters indexed: {len(chapters)}\n"
            f"Characters found: {len(chars)}\n"
            f"Characters: {', '.join(chars[:20])}"
        )

    elif name == "read_scene":
        from .parser import parse_chapter
        path = _resolve_file(BD, inputs["filename"])
        if path is None:
            return f"File not found: {inputs['filename']}. Available folders: chapters/, notes/"
        ch = parse_chapter(path)
        if ch is None:
            return "Failed to parse file."
        idx = inputs["scene_index"]
        if idx >= len(ch.scenes):
            return f"Scene {idx} not found. Chapter has {len(ch.scenes)} scenes."
        scene = ch.scenes[idx]
        return f"[Scene {idx} — {scene.location} — {scene.timeline}]\n{scene.text}"

    elif name == "read_chapter":
        path = _resolve_file(BD, inputs["filename"])
        if path is None:
            return f"File not found: {inputs['filename']}. Available folders: chapters/, notes/"
        return path.read_text(encoding="utf-8")

    elif name == "edit_scene":
        path = _resolve_file(BD, inputs["filename"])
        if path is None:
            return f"File not found: {inputs['filename']}. Available folders: chapters/, notes/"
        content = path.read_text(encoding="utf-8")
        old_text = inputs["old_text"]
        new_text = inputs["new_text"]
        if old_text not in content:
            return "Text not found in file. Make sure old_text matches exactly."
        new_content = content.replace(old_text, new_text, 1)
        path.write_text(new_content, encoding="utf-8")
        # Re-index the changed file
        try:
            from .importer import BookImporter
            importer = BookImporter(BD)
            importer._import_file(path)
        except Exception:
            pass
        return f"Done. Replaced text in {inputs['filename']}."

    elif name == "append_to_chapter":
        path = _resolve_file(BD, inputs["filename"])
        if path is None:
            return f"File not found: {inputs['filename']}. Available folders: chapters/, notes/"
        content = path.read_text(encoding="utf-8")
        separator = "\n\n---\n\n" if content.strip() else ""
        path.write_text(content + separator + inputs["text"], encoding="utf-8")
        return f"Appended to {inputs['filename']}."

    elif name == "write_scene":
        path = _resolve_file(BD, inputs["filename"])
        if path is None:
            return f"File not found: {inputs['filename']}. Available folders: chapters/, notes/"

        raw_text = inputs["text"].strip()
        location = inputs.get("location", "").strip()
        timeline = inputs.get("timeline", "").strip()

        # Format dialogue lines: "Name: text" → "[character: Name] — text"
        # Already formatted lines ("[character: ...] —") are left as-is
        import re
        formatted_lines = []
        dialogue_pattern = re.compile(r'^\[character:\s*[^\]]+\]\s*[—–-]')
        colon_pattern = re.compile(r'^([А-ЯІЇЄA-Z][^:]{1,30}):\s+(.+)$')
        for line in raw_text.splitlines():
            stripped = line.strip()
            if not stripped:
                formatted_lines.append("")
                continue
            if dialogue_pattern.match(stripped):
                # Already correctly formatted
                formatted_lines.append(stripped)
            else:
                m = colon_pattern.match(stripped)
                if m:
                    char_name = m.group(1).strip()
                    dialogue_text = m.group(2).strip()
                    formatted_lines.append(f"[character: {char_name}] — {dialogue_text}")
                else:
                    formatted_lines.append(stripped)

        formatted_text = "\n".join(formatted_lines)

        # Build scene block
        scene_parts = []
        if location or timeline:
            meta_lines = []
            if location:
                meta_lines.append(f"location:: {location}")
            if timeline:
                meta_lines.append(f"timeline:: {timeline}")
            scene_parts.append("\n".join(meta_lines))
            scene_parts.append("")
        scene_parts.append(formatted_text)
        scene_block = "\n".join(scene_parts)

        # Append with scene break separator
        existing = path.read_text(encoding="utf-8")
        separator = "\n\n---\n" if existing.strip() else ""
        path.write_text(existing + separator + scene_block + "\n", encoding="utf-8")

        # Re-index
        try:
            from .importer import BookImporter
            importer = BookImporter(BD)
            importer._import_file(path)
        except Exception:
            pass

        return f"Written to {inputs['filename']}.\n\nFormatted text:\n{scene_block}"

    elif name == "reimport_book":
        from .importer import BookImporter
        lang = os.environ.get("NOS_LANGUAGE", "en")
        importer = BookImporter(BD, language=lang)
        result = importer.import_book(force=False)
        return (
            f"Re-index complete.\n"
            f"Imported: {result['chapters_imported']} files\n"
            f"Skipped (unchanged): {result['chapters_skipped']} files\n"
            f"Characters found: {result['characters_found']}\n"
            + (f"Errors: {result['errors']}" if result['errors'] else "No errors.")
        )

    return f"Unknown tool: {name}"


def call_tool(name: str, inputs: dict, book_dir=None) -> str:
    try:
        return _dispatch(name, inputs, book_dir=Path(book_dir) if book_dir else None)
    except Exception as e:
        return f"Tool error ({name}): {e}"


# Alias used by agent.py
def execute_tool(name: str, inputs: dict, db=None, book_dir=None) -> str:
    return call_tool(name, inputs, book_dir=book_dir)
