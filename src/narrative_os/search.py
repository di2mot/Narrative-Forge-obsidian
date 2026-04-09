"""Semantic search over ChromaDB."""

from __future__ import annotations
import os
from pathlib import Path

from .embeddings import embed_one
from .vectorstore import get_client, get_collection, search, get_by_filter


def _get_collection(book_dir: Path):
    return get_collection(get_client(book_dir))


def search_semantic(book_dir: Path, query: str, n: int = 5) -> list[dict]:
    """Full semantic search -- embed query and find similar scenes."""
    lang = os.environ.get("NOS_LANGUAGE", "en")
    q_vec = embed_one(query, language=lang)
    col = _get_collection(book_dir)
    return search(col, q_vec, n=n)


def _dedup_by_scene(chunks: list[dict], n: int) -> list[dict]:
    """Keep only the first chunk per (chapter, scene_index) pair."""
    seen: set[tuple] = set()
    out = []
    for c in chunks:
        m = c["metadata"]
        key = (m.get("chapter"), m.get("scene_index"))
        if key not in seen:
            seen.add(key)
            out.append(c)
            if len(out) >= n:
                break
    return out


def search_by_character(book_dir: Path, name: str, n: int = 20) -> list[dict]:
    """Get scenes featuring a character (deduplicated per scene).

    ChromaDB's $contains on string fields is unreliable across versions,
    so we fetch all chunks and filter in Python.
    """
    col = _get_collection(book_dir)
    try:
        count = col.count()
        if count == 0:
            return []
        all_chunks = col.get(include=["documents", "metadatas"])
        raw = []
        for i, chunk_id in enumerate(all_chunks["ids"]):
            chars = all_chunks["metadatas"][i].get("characters", "")
            names = [c.strip() for c in chars.split(",") if c.strip()]
            if name in names:
                raw.append({
                    "id": chunk_id,
                    "text": all_chunks["documents"][i],
                    "metadata": all_chunks["metadatas"][i],
                })
        return _dedup_by_scene(raw, n)
    except Exception:
        return []


def search_by_location(book_dir: Path, location: str, n: int = 20) -> list[dict]:
    col = _get_collection(book_dir)
    raw = get_by_filter(col, where={"location": {"$eq": location}}, limit=500)
    return _dedup_by_scene(raw, n)


def get_chapter_scenes(book_dir: Path, chapter_number: int) -> list[dict]:
    col = _get_collection(book_dir)
    raw = get_by_filter(col, where={"chapter": {"$eq": chapter_number}}, limit=500)
    # Sort by scene_index, deduplicate (chunk_index=0 comes first when sorted)
    raw_sorted = sorted(raw, key=lambda r: (r["metadata"].get("scene_index", 0), r["metadata"].get("chunk_index", 0)))
    return _dedup_by_scene(raw_sorted, 200)


def list_chapters(book_dir: Path) -> list[dict]:
    """List all indexed chapters (deduplicated from metadata)."""
    col = _get_collection(book_dir)
    try:
        all_chunks = col.get(include=["metadatas"])
        seen = {}
        for meta in all_chunks["metadatas"]:
            if meta.get("type") == "note":
                continue
            ch_num = meta.get("chapter", 0)
            if ch_num not in seen:
                seen[ch_num] = {
                    "chapter": ch_num,
                    "title": meta.get("chapter_title", ""),
                    "filename": meta.get("filename", ""),
                }
        return sorted(seen.values(), key=lambda x: x["chapter"])
    except Exception:
        return []


def list_notes(book_dir: Path) -> list[dict]:
    """List all indexed notes (deduplicated by filename)."""
    col = _get_collection(book_dir)
    try:
        all_chunks = col.get(include=["metadatas"])
        seen: set[str] = set()
        notes = []
        for meta in all_chunks["metadatas"]:
            if meta.get("type") == "note":
                fname = meta.get("filename", "")
                if fname not in seen:
                    seen.add(fname)
                    notes.append({
                        "filename": fname,
                        "title": meta.get("title", ""),
                    })
        return sorted(notes, key=lambda x: x["title"])
    except Exception:
        return []


def list_characters(book_dir: Path) -> list[str]:
    """List all unique character names from indexed metadata."""
    col = _get_collection(book_dir)
    try:
        all_chunks = col.get(include=["metadatas"])
        chars: set[str] = set()
        for meta in all_chunks["metadatas"]:
            for name in meta.get("characters", "").split(","):
                name = name.strip()
                if name:
                    chars.add(name)
        return sorted(chars)
    except Exception:
        return []
