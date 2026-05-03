"""Parser for .md chapter files with YAML frontmatter."""

from __future__ import annotations
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

import yaml


@dataclass
class DialogueLine:
    character: str
    text: str


@dataclass
class Scene:
    location: str = ""
    timeline: str = ""
    text: str = ""           # full scene text (narrative + dialogue combined)
    dialogue: list[DialogueLine] = field(default_factory=list)
    characters: list[str] = field(default_factory=list)  # characters mentioned in THIS scene
    line_start: int = 0      # line number (0-based) where this scene starts in the body


@dataclass
class Chapter:
    number: int
    title: str
    location: str = ""
    timeline: str = ""
    characters: list[str] = field(default_factory=list)
    pov: str = ""
    status: str = "draft"
    word_target: int = 0
    scenes: list[Scene] = field(default_factory=list)
    raw_text: str = ""
    filename: str = ""


DIALOGUE_RE = re.compile(r'^\[character:\s*([^\]]+)\]\s*[—–-]\s*(.*)', re.IGNORECASE)
DATAVIEW_RE = re.compile(r'^(\w+)::\s*(.+)$')
WIKILINK_RE = re.compile(r'\[\[([^\]]+)\]\]')


def strip_wikilinks(text: str) -> str:
    """[[Name]] -> Name"""
    return WIKILINK_RE.sub(lambda m: m.group(1), text).strip()


def parse_wikilink_list(value: Any) -> list[str]:
    """Parse frontmatter characters/locations list -- strips [[]]."""
    if not value:
        return []
    if isinstance(value, list):
        return [strip_wikilinks(str(v)) for v in value]
    if isinstance(value, str):
        return [strip_wikilinks(value)]
    return []


def parse_chapter(path: Path) -> Chapter | None:
    """Parse a .md chapter file. Returns None on error."""
    try:
        raw = path.read_text(encoding="utf-8")
    except OSError:
        return None

    # Split frontmatter
    fm: dict[str, Any] = {}
    body = raw
    if raw.startswith("---"):
        parts = raw.split("---", 2)
        if len(parts) >= 3:
            try:
                fm = yaml.safe_load(parts[1]) or {}
            except yaml.YAMLError as e:
                fm = {"status": "yaml_error"}
                print(f"Warning: Failed to parse YAML frontmatter in {path}: {e}")
            body = parts[2].lstrip("\n")

    chapter = Chapter(
        number=int(fm.get("chapter", 0)),
        title=str(fm.get("title", path.stem)),
        location=strip_wikilinks(str(fm.get("location", ""))),
        timeline=str(fm.get("timeline", "")),
        characters=parse_wikilink_list(fm.get("characters")),
        pov=strip_wikilinks(str(fm.get("pov", ""))),
        status=str(fm.get("status", "draft")),
        word_target=int(fm.get("word_target", 0)),
        raw_text=body,
        filename=path.name,
    )

    # Parse scenes split by ---
    # Track line numbers by splitting on --- while recording positions
    body_lines = body.splitlines(keepends=True)
    raw_scenes: list[tuple[str, int]] = []  # (raw_scene_text, start_line_0based)
    current_start = 0
    current_block: list[str] = []
    for line_no, line in enumerate(body_lines):
        if re.match(r'^---\s*$', line):
            raw_scenes.append(("".join(current_block), current_start))
            current_block = []
            current_start = line_no + 1
        else:
            current_block.append(line)
    raw_scenes.append(("".join(current_block), current_start))

    current_location = chapter.location
    current_timeline = chapter.timeline

    for raw_scene_text, scene_line_start in raw_scenes:
        raw_scene = raw_scene_text.strip()
        if not raw_scene:
            continue

        scene = Scene(location=current_location, timeline=current_timeline, line_start=scene_line_start)
        lines = raw_scene.splitlines()
        text_lines = []

        # Parse Dataview inline metadata from top of scene block
        i = 0
        while i < len(lines):
            m = DATAVIEW_RE.match(lines[i].strip())
            if m:
                key, val = m.group(1).lower(), m.group(2).strip()
                if key == "location":
                    scene.location = strip_wikilinks(val)
                    current_location = scene.location
                elif key == "timeline":
                    scene.timeline = strip_wikilinks(val)
                    current_timeline = scene.timeline
                i += 1
            else:
                break

        # Parse remaining lines
        for line in lines[i:]:
            dm = DIALOGUE_RE.match(line.strip())
            if dm:
                char = dm.group(1).strip()
                text = dm.group(2).strip()
                scene.dialogue.append(DialogueLine(character=char, text=text))
                if char not in scene.characters:
                    scene.characters.append(char)
                text_lines.append(f"[{char}]: {text}")
            else:
                text_lines.append(line)

        scene.text = "\n".join(text_lines).strip()
        if scene.text:
            chapter.scenes.append(scene)

    return chapter


def parse_book(book_dir: Path) -> list[Chapter]:
    """Parse all .md chapter files in book_dir/chapters/ (or book_dir itself)."""
    chapters_dir = book_dir / "chapters"
    if chapters_dir.exists():
        search_dir = chapters_dir
    else:
        search_dir = book_dir

    chapters = []
    for path in sorted(search_dir.glob("*.md")):
        if path.name.startswith("_"):
            continue
        ch = parse_chapter(path)
        if ch and ch.scenes:
            chapters.append(ch)

    chapters.sort(key=lambda c: c.number)
    return chapters
