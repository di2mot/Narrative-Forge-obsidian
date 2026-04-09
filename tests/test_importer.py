"""Tests for BookImporter with ChromaDB."""
import pytest
from pathlib import Path
from narrative_os.importer import BookImporter

SAMPLE_MD = '''---
chapter: 1
title: "Test Chapter"
location: "[[Test City]]"
timeline: "Year 1"
characters:
  - "[[Alice]]"
  - "[[Bob]]"
---

Alice walked into the room.

[character: Alice] — Hello Bob.
[character: Bob] — Hello Alice.
'''

def test_import_creates_chunks(tmp_path):
    (tmp_path / "chapters").mkdir()
    (tmp_path / "chapters" / "01-test.md").write_text(SAMPLE_MD)
    importer = BookImporter(tmp_path, language="en")
    result = importer.import_book(force=True)
    assert result["chapters_imported"] == 1
    assert result["errors"] == []

def test_import_skips_unchanged(tmp_path):
    (tmp_path / "chapters").mkdir()
    (tmp_path / "chapters" / "01-test.md").write_text(SAMPLE_MD)
    importer = BookImporter(tmp_path, language="en")
    importer.import_book(force=True)
    result = importer.import_book(force=False)
    assert result["chapters_skipped"] == 1
    assert result["chapters_imported"] == 0

def test_import_force_reimports(tmp_path):
    (tmp_path / "chapters").mkdir()
    (tmp_path / "chapters" / "01-test.md").write_text(SAMPLE_MD)
    importer = BookImporter(tmp_path, language="en")
    importer.import_book(force=True)
    result = importer.import_book(force=True)
    assert result["chapters_imported"] == 1
