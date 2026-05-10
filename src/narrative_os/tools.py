"""Tool definitions and dispatcher for narrative-os AI agent."""

from __future__ import annotations
import os
import re
from pathlib import Path

_DIALOGUE_RE = re.compile(r'^\[character:\s*[^\]]+\]\s*[—–-]')
_COLON_RE = re.compile(r'^(?:\*\*|__)*([А-ЯІЇЄA-Z][^:\*\_]{1,30})(?:\*\*|__)*:\s+(.+)$')


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
    bd_resolved = BD.resolve()
    if "/" in filename:
        p = (BD / filename).resolve()
        return p if p.is_relative_to(bd_resolved) and p.exists() else None

    for subdir in ("chapters", "notes", ""):
        p = BD / subdir / filename if subdir else BD / filename
        p = p.resolve()
        if p.is_relative_to(bd_resolved) and p.exists():
            return p
    return None


def _dispatch(name: str, inputs: dict, book_dir: Path | None = None) -> str:
    """Proxy all tool calls to the Obsidian plugin's local server (port 18000).
    
    This ensures that Obsidian (Orama) is the single source of truth for 
    indexing and search, and that all file operations use Obsidian's Vault API.
    """
    import requests
    BD = book_dir if book_dir is not None else BOOK_DIR
    
    try:
        res = requests.post(
            "http://localhost:18000/execute_tool",
            json={"name": name, "input": inputs, "book_dir": str(BD)},
            timeout=30
        )
        res.raise_for_status()
        data = res.json()
        
        if data.get("status") == "ok":
            return data.get("result", "Done.")
        else:
            return f"Error from Obsidian: {data.get('message', 'Unknown error')}"
            
    except requests.exceptions.ConnectionError:
        return (
            f"Failed to contact Obsidian plugin local server on port 18000.\n"
            f"Is Obsidian running and the Narrative Forge plugin enabled?\n"
            f"Note: The Python bridge requires Obsidian to be open to access the book's index and files."
        )
    except Exception as e:
        return f"Bridge error calling {name}: {e}"


def call_tool(name: str, inputs: dict, book_dir=None) -> str:
    try:
        return _dispatch(name, inputs, book_dir=Path(book_dir) if book_dir else None)
    except Exception as e:
        return f"Tool error ({name}): {e}"


# Alias used by agent.py
def execute_tool(name: str, inputs: dict, db=None, book_dir=None) -> str:
    return call_tool(name, inputs, book_dir=book_dir)
