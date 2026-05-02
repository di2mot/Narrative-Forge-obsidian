"""ChromaDB wrapper for narrative-os."""

from __future__ import annotations
from pathlib import Path
import chromadb
from chromadb.config import Settings


def get_client(book_dir: Path) -> chromadb.Client:
    """Get persistent ChromaDB client for this book."""
    if not book_dir.exists():
        raise FileNotFoundError(f"Book directory does not exist: {book_dir}")
    db_path = book_dir / ".narrative.chromadb"
    db_path.mkdir(exist_ok=True)
    return chromadb.PersistentClient(
        path=str(db_path),
        settings=Settings(anonymized_telemetry=False),
    )


def get_collection(client: chromadb.Client, name: str = "book") -> chromadb.Collection:
    """Get or create the book collection."""
    return client.get_or_create_collection(
        name=name,
        metadata={"hnsw:space": "cosine"},
    )


def upsert_chunks(
    collection: chromadb.Collection,
    chunk_ids: list[str],
    embeddings: list[list[float]],
    documents: list[str],
    metadatas: list[dict],
) -> None:
    """Insert or update chunks in the collection."""
    collection.upsert(
        ids=chunk_ids,
        embeddings=embeddings,
        documents=documents,
        metadatas=metadatas,
    )


def set_collection_language(collection: chromadb.Collection, language: str) -> None:
    """Store the embedding language in collection metadata for consistent search."""
    try:
        current = collection.metadata or {}
        if current.get("language") != language:
            collection.modify(metadata={**current, "language": language})
    except Exception:
        pass


def get_collection_language(collection: chromadb.Collection) -> str:
    """Read embedding language from collection metadata."""
    try:
        return (collection.metadata or {}).get("language", "en")
    except Exception:
        return "en"


def delete_chapter(collection: chromadb.Collection, chapter_number: int) -> None:
    """Delete all chunks for a chapter (for re-import)."""
    try:
        results = collection.get(where={"chapter": chapter_number})
        if results["ids"]:
            collection.delete(ids=results["ids"])
    except Exception:
        pass


def search(
    collection: chromadb.Collection,
    query_embedding: list[float],
    n: int = 5,
    where: dict | None = None,
) -> list[dict]:
    """Similarity search. Returns list of result dicts."""
    kwargs: dict = {"query_embeddings": [query_embedding], "n_results": min(n, collection.count() or 1)}
    if where:
        kwargs["where"] = where
    results = collection.query(**kwargs, include=["documents", "metadatas", "distances"])

    out = []
    ids = results["ids"][0]
    docs = results["documents"][0]
    metas = results["metadatas"][0]
    dists = results["distances"][0]
    for i, chunk_id in enumerate(ids):
        out.append({
            "id": chunk_id,
            "text": docs[i],
            "metadata": metas[i],
            "score": 1.0 - dists[i],  # cosine distance -> similarity
        })
    return out


def get_by_filter(
    collection: chromadb.Collection,
    where: dict,
    limit: int = 50,
) -> list[dict]:
    """Get chunks by metadata filter."""
    try:
        count = collection.count()
        if count == 0:
            return []
        results = collection.get(where=where, limit=limit, include=["documents", "metadatas"])
        out = []
        for i, chunk_id in enumerate(results["ids"]):
            out.append({
                "id": chunk_id,
                "text": results["documents"][i],
                "metadata": results["metadatas"][i],
            })
        return out
    except Exception:
        return []
