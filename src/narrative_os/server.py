"""FastAPI server -- minimal backend for Obsidian plugin."""

from __future__ import annotations
import json
import os
from pathlib import Path

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse

from .agent import get_provider, run_agent_turn
from .importer import BookImporter
from . import search as search_mod

BOOK_DIR = Path(os.environ.get("NOS_BOOK_DIR", os.getcwd()))
LANGUAGE = os.environ.get("NOS_LANGUAGE", "en")

app = FastAPI(title="Narrative Forge", version="0.4.0")
app.add_middleware(CORSMiddleware, allow_origins=["*"], allow_methods=["*"], allow_headers=["*"])


@app.get("/api/health")
def health():
    try:
        chapters = search_mod.list_chapters(BOOK_DIR)
        characters = search_mod.list_characters(BOOK_DIR)
    except Exception:
        chapters, characters = [], []
    return {
        "status": "ok",
        "book_dir": str(BOOK_DIR),
        "chapters": len(chapters),
        "characters": len(characters),
        "provider": get_provider(),
    }


@app.post("/api/import")
def import_book(force: bool = False, book_dir: str = "", language: str = ""):
    bd = Path(book_dir) if book_dir else BOOK_DIR
    lang = language or os.environ.get("NOS_LANGUAGE", LANGUAGE)
    importer = BookImporter(bd, language=lang)
    return importer.import_book(force=force)


@app.post("/api/chat")
async def chat(request: Request):
    body = await request.json()
    messages = body.get("messages", [])
    api_key = body.get("api_key") or os.environ.get("ANTHROPIC_API_KEY")
    model = body.get("model")
    provider = body.get("provider")
    book_dir = body.get("book_dir") or str(BOOK_DIR)
    language = body.get("language") or os.environ.get("NOS_LANGUAGE", "en")

    if not messages:
        raise HTTPException(400, "messages required")

    async def event_stream():
        async for event in run_agent_turn(messages, None, api_key=api_key, model=model, provider=provider, book_dir=book_dir, language=language):
            if event.type == "tool_use":
                print(f"[TOOL] {event.data.get('name')}({json.dumps(event.data.get('input', {}), ensure_ascii=False)})", flush=True)
            elif event.type == "tool_result":
                print(f"[TOOL] <- {str(event.data.get('result', ''))[:200]}", flush=True)
            yield f"data: {json.dumps(event.__dict__, ensure_ascii=False, default=str)}\n\n"

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.post("/api/tools")
async def execute_tool_endpoint(request: Request):
    from .tools import execute_tool
    body = await request.json()
    name = body.get("name")
    inputs = body.get("input", {})
    book_dir = body.get("book_dir") or str(BOOK_DIR)
    
    if not name:
        raise HTTPException(400, "tool name required")
        
    try:
        print(f"[API TOOL] {name}({json.dumps(inputs, ensure_ascii=False)})", flush=True)
        result = execute_tool(name, inputs, db=None, book_dir=book_dir)
        return {"status": "ok", "result": result}
    except Exception as e:
        raise HTTPException(500, f"Tool error: {str(e)}")
