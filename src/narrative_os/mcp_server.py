"""FastMCP stdio server -- exposes narrative-os tools to Claude Desktop."""

from __future__ import annotations
import os
from pathlib import Path

from mcp.server.fastmcp import FastMCP

from .tools import call_tool

BOOK_DIR = Path(os.environ.get("NOS_BOOK_DIR", "."))

mcp = FastMCP("narrative-forge")


@mcp.tool()
def search_semantic(query: str, n: int = 5) -> str:
    """Semantic similarity search over all scenes in the book."""
    return call_tool("search_semantic", {"query": query, "n": n}, book_dir=BOOK_DIR)


@mcp.tool()
def search_by_character(name: str, n: int = 20) -> str:
    """Find all scenes featuring a specific character."""
    return call_tool("search_by_character", {"name": name, "n": n}, book_dir=BOOK_DIR)


@mcp.tool()
def search_by_location(location: str, n: int = 20) -> str:
    """Find all scenes set in a specific location."""
    return call_tool("search_by_location", {"location": location, "n": n}, book_dir=BOOK_DIR)


@mcp.tool()
def get_chapter(chapter_number: int) -> str:
    """Get all scenes from a specific chapter."""
    return call_tool("get_chapter", {"chapter_number": chapter_number}, book_dir=BOOK_DIR)


@mcp.tool()
def list_chapters() -> str:
    """List all indexed chapters."""
    return call_tool("list_chapters", {}, book_dir=BOOK_DIR)


@mcp.tool()
def list_characters() -> str:
    """List all unique characters in the book."""
    return call_tool("list_characters", {}, book_dir=BOOK_DIR)


@mcp.tool()
def get_book_info() -> str:
    """Get general information about the book."""
    return call_tool("get_book_info", {}, book_dir=BOOK_DIR)


@mcp.tool()
def read_scene(filename: str, scene_index: int) -> str:
    """Read the raw text of a specific scene from a chapter file."""
    return call_tool("read_scene", {"filename": filename, "scene_index": scene_index}, book_dir=BOOK_DIR)


@mcp.tool()
def read_chapter(filename: str) -> str:
    """Read the full raw text of a chapter file."""
    return call_tool("read_chapter", {"filename": filename}, book_dir=BOOK_DIR)


@mcp.tool()
def edit_scene(filename: str, old_text: str, new_text: str) -> str:
    """Edit a scene by replacing exact text."""
    return call_tool("edit_scene", {"filename": filename, "old_text": old_text, "new_text": new_text}, book_dir=BOOK_DIR)


@mcp.tool()
def append_to_chapter(filename: str, text: str) -> str:
    """Append text to the end of a chapter file."""
    return call_tool("append_to_chapter", {"filename": filename, "text": text}, book_dir=BOOK_DIR)


@mcp.tool()
def write_scene(filename: str, text: str, location: str = "", timeline: str = "") -> str:
    """Write a new scene or dialogue and append it to a chapter file with correct formatting."""
    return call_tool("write_scene", {"filename": filename, "text": text, "location": location, "timeline": timeline}, book_dir=BOOK_DIR)


@mcp.tool()
def reimport_book() -> str:
    """Re-index the entire book into the vector database."""
    return call_tool("reimport_book", {}, book_dir=BOOK_DIR)


def main() -> None:
    mcp.run(transport="stdio")


if __name__ == "__main__":
    main()
