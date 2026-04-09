"""Tests for semantic search."""
import pytest
from pathlib import Path
from narrative_os.importer import BookImporter
from narrative_os import search as search_mod

SAMPLE_MD = '''---
chapter: 1
title: "The Battle"
location: "[[Andruil]]"
timeline: "Year 1105"
characters:
  - "[[Artur]]"
  - "[[Sam]]"
---

The walls of Andruil stood against the enemy army.

[character: Sam] — The gate is breaking, my lord.
[character: Artur] — Hold the line.

---
location:: [[Forest]]
timeline:: Year 1105, morning

Mark rode through the dark forest alone.

[character: Mark] — I must reach the city in time.
'''

@pytest.fixture
def indexed_book(tmp_path):
    (tmp_path / "chapters").mkdir()
    (tmp_path / "chapters" / "01-battle.md").write_text(SAMPLE_MD)
    importer = BookImporter(tmp_path, language="en")
    importer.import_book(force=True)
    return tmp_path

def test_list_chapters(indexed_book):
    chapters = search_mod.list_chapters(indexed_book)
    assert len(chapters) == 1
    assert chapters[0]["chapter"] == 1

def test_list_characters(indexed_book):
    chars = search_mod.list_characters(indexed_book)
    assert "Artur" in chars
    assert "Sam" in chars
    assert "Mark" in chars

def test_search_by_character(indexed_book):
    results = search_mod.search_by_character(indexed_book, "Artur")
    assert len(results) > 0
    assert any("Artur" in r["metadata"]["characters"] for r in results)

def test_search_by_location(indexed_book):
    results = search_mod.search_by_location(indexed_book, "Andruil")
    assert len(results) > 0
    assert all(r["metadata"]["location"] == "Andruil" for r in results)

def test_get_chapter_scenes(indexed_book):
    scenes = search_mod.get_chapter_scenes(indexed_book, 1)
    assert len(scenes) == 2

def test_semantic_search(indexed_book):
    results = search_mod.search_semantic(indexed_book, "battle and defense", n=3)
    assert len(results) > 0
    # Top result should be about walls/battle
    assert results[0]["score"] > 0
