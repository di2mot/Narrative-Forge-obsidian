"""Sentence-transformer embeddings with auto model selection."""

from __future__ import annotations
import os
from functools import lru_cache
from sentence_transformers import SentenceTransformer


EN_MODEL = "all-MiniLM-L6-v2"
MULTILINGUAL_MODEL = "paraphrase-multilingual-MiniLM-L12-v2"


@lru_cache(maxsize=2)
def _load_model(model_name: str) -> SentenceTransformer:
    """Load and cache a SentenceTransformer model by name."""
    return SentenceTransformer(model_name)


def get_model(language: str = "en") -> SentenceTransformer:
    """Load model based on language. Cached after first load."""
    model_name = os.environ.get(
        "NOS_EMBEDDING_MODEL",
        EN_MODEL if language == "en" else MULTILINGUAL_MODEL,
    )
    return _load_model(model_name)


def embed(texts: list[str], language: str = "en") -> list[list[float]]:
    """Embed a list of texts. Returns list of float vectors."""
    model = get_model(language)
    vectors = model.encode(texts, show_progress_bar=False, normalize_embeddings=True)
    return [v.tolist() for v in vectors]


def embed_one(text: str, language: str = "en") -> list[float]:
    """Embed a single text. Convenience wrapper around embed()."""
    return embed([text], language)[0]
