"""Import .md chapters into ChromaDB."""

from __future__ import annotations
import hashlib
import json
import os
from pathlib import Path

import chromadb
from chromadb import Collection

from .parser import parse_book, Chapter, Scene
from .embeddings import embed
from .vectorstore import get_client, get_collection, upsert_chunks, delete_chapter


def _chunk_id(chapter: int, scene_idx: int, chunk_idx: int = 0) -> str:
    return f"ch{chapter:04d}_sc{scene_idx:04d}_ck{chunk_idx:04d}"


def _note_chunk_id(filename: str) -> str:
    safe = filename.replace("/", "_").replace("\\", "_")
    return f"note__{safe}"


_CHUNK_WORDS = 150   # target window size in words
_CHUNK_OVERLAP = 30  # overlap between consecutive chunks


def _split_words(text: str, window: int, overlap: int) -> list[str]:
    """Split text into overlapping word windows."""
    words = text.split()
    if len(words) <= window:
        return [text]
    chunks = []
    step = window - overlap
    start = 0
    while start < len(words):
        end = start + window
        chunks.append(" ".join(words[start:end]))
        if end >= len(words):
            break
        start += step
    return chunks


def _scene_to_chunks(chapter: Chapter, scene: Scene, scene_idx: int) -> list[dict]:
    """Split a scene into overlapping word-window chunks."""
    if not scene.text.strip():
        return []

    windows = _split_words(scene.text, _CHUNK_WORDS, _CHUNK_OVERLAP)
    scene_preview = scene.text[:200]
    base_meta = {
        "chapter": chapter.number,
        "chapter_title": chapter.title,
        "scene_index": scene_idx,
        "location": scene.location,
        "timeline": scene.timeline,
        "characters": ",".join(scene.characters) if scene.characters else "",
        "pov": chapter.pov,
        "filename": chapter.filename,
        "line_start": scene.line_start,
        "type": "scene",
        "chunk_total": len(windows),
        "scene_preview": scene_preview,
    }

    result = []
    for ck_idx, window_text in enumerate(windows):
        meta = {**base_meta, "chunk_index": ck_idx}
        result.append({
            "id": _chunk_id(chapter.number, scene_idx, ck_idx),
            "text": window_text,
            "metadata": meta,
        })
    return result


class BookImporter:
    def __init__(self, book_dir: Path, language: str = "en"):
        self.book_dir = book_dir
        self.language = language
        self.hashes_path = book_dir / ".nos.hashes.json"
        self._hashes: dict[str, str] = self._load_hashes()

    def _load_hashes(self) -> dict[str, str]:
        if self.hashes_path.exists():
            try:
                return json.loads(self.hashes_path.read_text())
            except Exception:
                return {}
        return {}

    def _save_hashes(self) -> None:
        self.hashes_path.write_text(json.dumps(self._hashes, indent=2))

    def _file_hash(self, path: Path) -> str:
        return hashlib.sha256(path.read_bytes()).hexdigest()[:16]

    def import_book(self, force: bool = False) -> dict:
        client = get_client(self.book_dir)
        collection = get_collection(client)

        chapters = parse_book(self.book_dir)
        lang = os.environ.get("NOS_LANGUAGE", self.language)

        imported = 0
        skipped = 0
        errors = []

        # --- Index chapters ---
        for chapter in chapters:
            chapters_dir = self.book_dir / "chapters"
            search_dir = chapters_dir if chapters_dir.exists() else self.book_dir
            path = search_dir / chapter.filename

            file_hash = self._file_hash(path)
            if not force and self._hashes.get(chapter.filename) == file_hash:
                skipped += 1
                continue

            try:
                delete_chapter(collection, chapter.number)

                all_chunks: list[dict] = []
                for scene_idx, scene in enumerate(chapter.scenes):
                    all_chunks.extend(_scene_to_chunks(chapter, scene, scene_idx))

                if all_chunks:
                    texts = [c["text"] for c in all_chunks]
                    embeddings = embed(texts, language=lang)
                    upsert_chunks(
                        collection,
                        chunk_ids=[c["id"] for c in all_chunks],
                        embeddings=embeddings,
                        documents=texts,
                        metadatas=[c["metadata"] for c in all_chunks],
                    )

                self._hashes[chapter.filename] = file_hash
                imported += 1

            except Exception as e:
                errors.append(f"{chapter.filename}: {e}")

        # --- Index notes ---
        notes_imported, notes_skipped, notes_errors = self._import_notes(collection, lang, force)
        imported += notes_imported
        skipped += notes_skipped
        errors.extend(notes_errors)

        self._save_hashes()

        return {
            "chapters_imported": imported,
            "chapters_skipped": skipped,
            "characters_found": len({c for ch in chapters for c in ch.characters}),
            "errors": errors,
            "summary": f"Imported {imported} files, skipped {skipped}.",
        }

    def _import_notes(
        self, collection: Collection, lang: str, force: bool
    ) -> tuple[int, int, list[str]]:
        """Index all .md files in the notes/ folder."""
        notes_dir = self.book_dir / "notes"
        if not notes_dir.exists():
            return 0, 0, []

        imported = 0
        skipped = 0
        errors: list[str] = []

        for path in sorted(notes_dir.glob("*.md")):
            if path.name.startswith("_"):
                continue

            rel = f"notes/{path.name}"
            file_hash = self._file_hash(path)
            if not force and self._hashes.get(rel) == file_hash:
                skipped += 1
                continue

            try:
                text = path.read_text(encoding="utf-8").strip()
                # Strip YAML frontmatter
                if text.startswith("---"):
                    end = text.find("---", 3)
                    if end != -1:
                        text = text[end + 3:].strip()

                if not text:
                    skipped += 1
                    continue

                base_note_id = _note_chunk_id(path.name)
                title = path.stem.replace("-", " ").replace("_", " ")

                # Delete old chunks (may be more than one if note grew)
                try:
                    existing = collection.get(where={"filename": path.name})
                    if existing["ids"]:
                        collection.delete(ids=existing["ids"])
                except Exception:
                    try:
                        collection.delete(ids=[base_note_id])
                    except Exception:
                        pass

                windows = _split_words(text, _CHUNK_WORDS, _CHUNK_OVERLAP)
                chunk_ids = [
                    f"{base_note_id}__ck{i:04d}" if len(windows) > 1 else base_note_id
                    for i in range(len(windows))
                ]
                metadatas = [
                    {
                        "type": "note",
                        "filename": path.name,
                        "title": title,
                        "chunk_index": i,
                        "chunk_total": len(windows),
                    }
                    for i in range(len(windows))
                ]

                embeddings = embed(windows, language=lang)
                upsert_chunks(
                    collection,
                    chunk_ids=chunk_ids,
                    embeddings=embeddings,
                    documents=windows,
                    metadatas=metadatas,
                )

                self._hashes[rel] = file_hash
                imported += 1

            except Exception as e:
                errors.append(f"notes/{path.name}: {e}")

        return imported, skipped, errors

    def _import_file(self, path: Path) -> None:
        """Re-index a single file after edit."""
        from .parser import parse_chapter
        from .vectorstore import get_client, get_collection, delete_chapter

        ch = parse_chapter(path)
        if not ch or not ch.scenes:
            return

        lang = os.environ.get("NOS_LANGUAGE", self.language)
        client = get_client(self.book_dir)
        collection = get_collection(client)

        delete_chapter(collection, ch.number)

        all_chunks = []
        for scene_idx, scene in enumerate(ch.scenes):
            all_chunks.extend(_scene_to_chunks(ch, scene, scene_idx))

        if all_chunks:
            texts = [c["text"] for c in all_chunks]
            embeddings = embed(texts, language=lang)
            upsert_chunks(
                collection,
                chunk_ids=[c["id"] for c in all_chunks],
                embeddings=embeddings,
                documents=texts,
                metadatas=[c["metadata"] for c in all_chunks],
            )

        self._hashes[path.name] = self._file_hash(path)
        self._save_hashes()
