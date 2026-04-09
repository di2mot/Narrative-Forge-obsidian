"""Tests for .md chapter parser."""
import tempfile
from pathlib import Path
from narrative_os.parser import parse_chapter, parse_book

SAMPLE_MD = '''---
chapter: 1
title: "The Siege"
location: "[[Andruil]]"
timeline: "Year 1105"
characters:
  - "[[Artur]]"
  - "[[Sam]]"
---

Narrative text here.

[character: Sam] — My lord, the gate won't hold.
[character: Artur] — Reinforce it.

---
location:: [[Forest]]
timeline:: Year 1105, earlier

Mark rode through the forest.

[character: Mark] — Open the gates!
'''

def test_parse_chapter_frontmatter(tmp_path):
    f = tmp_path / "01-siege.md"
    f.write_text(SAMPLE_MD)
    ch = parse_chapter(f)
    assert ch is not None
    assert ch.number == 1
    assert ch.title == "The Siege"
    assert ch.location == "Andruil"
    assert "Artur" in ch.characters
    assert "Sam" in ch.characters

def test_parse_chapter_scenes(tmp_path):
    f = tmp_path / "01-siege.md"
    f.write_text(SAMPLE_MD)
    ch = parse_chapter(f)
    assert len(ch.scenes) == 2

def test_parse_scene_dialogue(tmp_path):
    f = tmp_path / "01-siege.md"
    f.write_text(SAMPLE_MD)
    ch = parse_chapter(f)
    scene = ch.scenes[0]
    assert len(scene.dialogue) == 2
    assert scene.dialogue[0].character == "Sam"
    assert "gate" in scene.dialogue[0].text

def test_parse_scene_break_metadata(tmp_path):
    f = tmp_path / "01-siege.md"
    f.write_text(SAMPLE_MD)
    ch = parse_chapter(f)
    scene2 = ch.scenes[1]
    assert scene2.location == "Forest"
    assert "earlier" in scene2.timeline

def test_parse_book(tmp_path):
    chapters_dir = tmp_path / "chapters"
    chapters_dir.mkdir()
    (chapters_dir / "01-siege.md").write_text(SAMPLE_MD)
    (chapters_dir / "_styles.md").write_text("skip this")
    chapters = parse_book(tmp_path)
    assert len(chapters) == 1
    assert chapters[0].number == 1

def test_strip_wikilinks(tmp_path):
    f = tmp_path / "01.md"
    f.write_text(SAMPLE_MD)
    ch = parse_chapter(f)
    # location should be stripped of [[]]
    assert ch.location == "Andruil"
    assert "[[" not in ch.location
