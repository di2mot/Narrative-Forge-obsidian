"""AI agent loop — bridges LLM provider to tools.

Two providers available:
- "api"  — Anthropic API (requires ANTHROPIC_API_KEY, supports tool_use)
- "cli"  — Claude Code CLI (uses subscription via OAuth, no API key needed)

Both yield the same AgentEvent stream. server.py doesn't know which is behind.

Selection: NOS_AGENT_PROVIDER env var ("api" or "cli"), default "cli".
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import sys
import tempfile
from dataclasses import dataclass, field
from typing import Any, AsyncGenerator, Literal

from .tools import TOOL_DEFINITIONS, execute_tool


_BASE_SYSTEM_PROMPT = """\
You are an expert fiction writing assistant. You help authors write, edit, and maintain consistency in their books.

## Your capabilities
- Semantic search across all scenes and chapters
- Reading and editing chapter files directly
- Writing new scenes and dialogue directly into chapter files
- Finding scenes by character, location, or concept
- Detecting contradictions and continuity errors
- Analyzing character arcs and plot threads

## How to work
- Start every session by calling `get_book_info` to confirm the book is indexed. If it says "No chapters indexed", tell the author to click Import in the sidebar — do not attempt to use other tools until the book is indexed.
- NEVER guess or fabricate story details — always use tools to look up information first
- Before editing: always call read_scene or read_chapter to get the exact current text
- To find relevant scenes: use search_semantic first, then read_scene for exact text
- edit_scene requires exact text match — copy it precisely from read_scene output
- Call multiple tools in sequence for complex tasks
- Respond in the same language the author writes in
- **NEVER ask for permission before using tools** — don't say "may I read this file?" or "shall I proceed?" — just use the tool immediately
- If the message includes `[Active file: filename]`, use that filename directly in tool calls without asking
- When the author asks to edit/write something, do it immediately with tools — no confirmation needed

## Writing new content
When the author asks to write a scene, dialogue, or passage:
1. Use search_semantic or search_by_character to get context about the characters/situation
2. Write the content following the formatting rules below
3. Use write_scene tool to append it directly to the chapter file
4. Show the written text to the author in your response

## Dialogue formatting rules — ALWAYS follow these
Dialogue MUST use this exact format:
```
[character: Ім'я] — Текст діалогу.
```
Examples:
```
[character: Рей] — Де ми знаходимось?
[character: Фрейя] — Не знаю. Але це не Ганімед.
```
Rules:
- Square brackets around `character: Name`
- Em dash `—` (not hyphen `-`) after the closing bracket
- One space before and after the em dash
- Each dialogue line on its own line
- Narrative text between dialogue lines has no special formatting

## Scene break formatting
New scene (new location or time jump):
```
---
location:: Назва локації
timeline:: Час або дата

Текст нової сцени.
```

## Editing rules
- Preserve the author's voice and style completely
- Keep character names, locations, and facts consistent with the story bible (CLAUDE.md)
- Only change what was asked — don't rewrite surrounding text
- After writing or editing, show the result and briefly confirm what was done

## Story bible
The CLAUDE.md file in the book directory contains the full story bible — characters, world, lore, rules.
You MUST follow everything in CLAUDE.md when writing or editing.
"""


def _build_system_prompt(book_dir_path) -> str:
    """Build system prompt, injecting CLAUDE.md if present."""
    from pathlib import Path
    book_dir = Path(book_dir_path)

    # Read CLAUDE.md from book dir
    claude_md = book_dir / "CLAUDE.md"
    if not claude_md.exists():
        # Try parent (for books inside vault subfolders)
        claude_md = book_dir / "chapters" / ".." / "CLAUDE.md"

    skill_md = book_dir / "SKILL.md"

    prompt_parts = [_BASE_SYSTEM_PROMPT]

    if claude_md.exists():
        content = claude_md.read_text(encoding="utf-8").strip()
        if content:
            prompt_parts.append(f"## Story Bible (CLAUDE.md)\n\n{content}")

    if skill_md.exists():
        content = skill_md.read_text(encoding="utf-8").strip()
        if content:
            prompt_parts.append(f"## Additional instructions (SKILL.md)\n\n{content}")

    return "\n\n---\n\n".join(prompt_parts)

MAX_TOOL_ROUNDS = 10


@dataclass
class AgentEvent:
    """Provider-agnostic event from the agent loop."""
    type: Literal["text_delta", "tool_use", "tool_result", "error", "done"]
    data: dict[str, Any] = field(default_factory=dict)


def get_provider() -> str:
    return os.environ.get("NOS_AGENT_PROVIDER", "cli")


async def run_agent_turn(
    messages: list[dict[str, Any]],
    db=None,
    api_key: str | None = None,
    model: str | None = None,
    provider: str | None = None,
    book_dir: str | None = None,
    language: str | None = None,
) -> AsyncGenerator[AgentEvent, None]:
    """Run one agent turn. Dispatches to the configured provider."""
    prov = provider or get_provider()
    bd = book_dir or os.environ.get("NOS_BOOK_DIR", ".")
    lang = language or os.environ.get("NOS_LANGUAGE", "en")

    if prov == "api":
        async for event in _run_api_turn(messages, db, api_key=api_key, model=model, book_dir=bd):
            yield event
    elif prov == "cli":
        async for event in _run_cli_turn(messages, db, book_dir=bd, language=lang):
            yield event
    else:
        yield AgentEvent(type="error", data={"message": f"Unknown provider: {prov}"})


# ---------------------------------------------------------------------------
# Provider: Anthropic API (requires ANTHROPIC_API_KEY)
# ---------------------------------------------------------------------------


async def _run_api_turn(
    messages: list[dict[str, Any]],
    db=None,
    api_key: str | None = None,
    model: str | None = None,
    book_dir: str | None = None,
) -> AsyncGenerator[AgentEvent, None]:
    try:
        import anthropic
    except ImportError:
        yield AgentEvent(type="error", data={"message": "anthropic package not installed. pip install anthropic"})
        return

    key = api_key or os.environ.get("ANTHROPIC_API_KEY", "")
    if not key:
        yield AgentEvent(type="error", data={"message": "ANTHROPIC_API_KEY not set"})
        return

    model_name = model or os.environ.get("NOS_AGENT_MODEL", "claude-sonnet-4-20250514")
    client = anthropic.AsyncAnthropic(api_key=key)

    working_messages = [_normalize_message(m) for m in messages]
    bd = os.path.abspath(book_dir or os.environ.get("NOS_BOOK_DIR", "."))
    system_prompt = _build_system_prompt(bd)

    for _ in range(MAX_TOOL_ROUNDS):
        try:
            response = await client.messages.create(
                model=model_name,
                max_tokens=4096,
                system=system_prompt,
                tools=TOOL_DEFINITIONS,
                messages=working_messages,
            )
        except anthropic.APIError as e:
            yield AgentEvent(type="error", data={"message": str(e)})
            return

        assistant_content = response.content
        tool_calls = []

        for block in assistant_content:
            if block.type == "text":
                yield AgentEvent(type="text_delta", data={"text": block.text})
            elif block.type == "tool_use":
                tool_calls.append(block)
                yield AgentEvent(
                    type="tool_use",
                    data={"id": block.id, "name": block.name, "input": block.input},
                )

        if response.stop_reason != "tool_use":
            yield AgentEvent(type="done", data={"stop_reason": response.stop_reason})
            return

        working_messages.append({"role": "assistant", "content": assistant_content})
        tool_results = []
        for tc in tool_calls:
            result_str = execute_tool(tc.name, tc.input, db, book_dir=bd)
            tool_results.append({
                "type": "tool_result",
                "tool_use_id": tc.id,
                "content": result_str,
            })
            yield AgentEvent(
                type="tool_result",
                data={"tool_use_id": tc.id, "name": tc.name, "result": result_str},
            )

        working_messages.append({"role": "user", "content": tool_results})

    yield AgentEvent(type="error", data={"message": "Max tool rounds reached"})


# ---------------------------------------------------------------------------
# Provider: Claude Code CLI (uses subscription, no API key)
# ---------------------------------------------------------------------------


def _build_cli_prompt(messages: list[dict[str, Any]], db=None, book_dir: str | None = None) -> str:
    """Build a single prompt for claude CLI from messages + book context."""
    from pathlib import Path
    from .tools import call_tool

    book_dir = Path(os.path.abspath(book_dir or os.environ.get("NOS_BOOK_DIR", ".")))
    system_prompt = _build_system_prompt(book_dir)
    parts = [system_prompt, ""]
    
    try:
        # Use proxy tools to get book context from Obsidian
        chapters_str = call_tool("list_chapters", {}, book_dir=book_dir)
        if chapters_str and not chapters_str.startswith("Error"):
            parts.append("## Book structure")
            parts.append(chapters_str)
            parts.append("")

        chars_str = call_tool("list_characters", {}, book_dir=book_dir)
        if chars_str and not chars_str.startswith("Error"):
            parts.append(f"## Characters: {chars_str}")
            parts.append("")
    except Exception:
        pass

    # Add conversation
    parts.append("## Conversation")
    for msg in messages:
        role = msg.get("role", "user")
        content = msg.get("content", "")

        if isinstance(content, str):
            parts.append(f"[{role}]: {content}")
        elif isinstance(content, dict):
            # Selection context
            text = content.get("text", "")
            selection = content.get("selection", "")
            file_name = content.get("file", "")

            if file_name:
                parts.append(f"[context: file {file_name}]")
            if selection:
                parts.append(f"[selected text]:\n{selection}\n[/selected text]")
            if text:
                parts.append(f"[{role}]: {text}")

    return "\n".join(parts)


async def _run_cli_turn(
    messages: list[dict[str, Any]],
    db=None,
    book_dir: str | None = None,
    language: str | None = None,
) -> AsyncGenerator[AgentEvent, None]:
    claude_path = shutil.which("claude")
    if not claude_path:
        yield AgentEvent(type="error", data={"message": "claude CLI not found in PATH. Install: https://docs.anthropic.com/en/docs/claude-code"})
        return

    bd = os.path.abspath(book_dir or os.environ.get("NOS_BOOK_DIR", "."))
    mcp_config = {
        "mcpServers": {
            "narrative-forge": {
                "command": sys.executable,
                "args": ["-m", "narrative_os"],
                "env": {
                    "NOS_BOOK_DIR": bd,
                    "NOS_LANGUAGE": language or os.environ.get("NOS_LANGUAGE", "en"),
                },
            }
        }
    }

    mcp_config_path = None
    try:
        with tempfile.NamedTemporaryFile(mode="w", suffix=".json", delete=False) as f:
            mcp_config_path = f.name
            json.dump(mcp_config, f)
    except OSError as e:
        if mcp_config_path:
            try:
                os.unlink(mcp_config_path)
            except OSError:
                pass
        yield AgentEvent(type="error", data={"message": f"Failed to write MCP config: {e}"})
        return

    prompt = _build_cli_prompt(messages, db, book_dir=bd)

    # Pre-grant all narrative-os MCP tools so CLI never asks for permission
    _nos_tools = [
        "mcp__narrative-forge__search_semantic",
        "mcp__narrative-forge__search_by_character",
        "mcp__narrative-forge__search_by_location",
        "mcp__narrative-forge__get_chapter",
        "mcp__narrative-forge__list_chapters",
        "mcp__narrative-forge__list_characters",
        "mcp__narrative-forge__get_book_info",
        "mcp__narrative-forge__read_scene",
        "mcp__narrative-forge__read_chapter",
        "mcp__narrative-forge__edit_scene",
        "mcp__narrative-forge__append_to_chapter",
        "mcp__narrative-forge__write_scene",
        "mcp__narrative-forge__reimport_book",
    ]

    try:
        proc = await asyncio.create_subprocess_exec(
            claude_path, "-p", prompt,
            "--output-format", "stream-json", "--verbose",
            "--mcp-config", mcp_config_path,
            "--allowedTools", ",".join(_nos_tools),
            "--disallowedTools", "Bash,Edit,Write,Read,Glob,Grep,NotebookEdit,WebFetch,WebSearch,Task,ReadMcpResourceTool",
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
            cwd=bd,  # Run from book dir so CLI reads the book's CLAUDE.md, not the tool's
        )
    except OSError as e:
        yield AgentEvent(type="error", data={"message": f"Failed to start claude CLI: {e}"})
        os.unlink(mcp_config_path)
        return

    # Drain stderr concurrently to prevent deadlock if the stderr pipe buffer fills
    stderr_task = asyncio.create_task(proc.stderr.read())

    buffer = ""
    async for chunk in proc.stdout:
        buffer += chunk.decode("utf-8", errors="replace")
        while "\n" in buffer:
            line, buffer = buffer.split("\n", 1)
            line = line.strip()
            if not line:
                continue
            try:
                event = json.loads(line)
            except json.JSONDecodeError:
                continue

            # Claude CLI stream-json format
            msg_type = event.get("type", "")

            if msg_type == "assistant" and "message" in event:
                msg = event["message"]
                if isinstance(msg, str):
                    if msg:
                        yield AgentEvent(type="text_delta", data={"text": msg})
                elif isinstance(msg, dict):
                    for block in msg.get("content", []):
                        if not isinstance(block, dict):
                            continue
                        if block.get("type") == "text" and block.get("text"):
                            yield AgentEvent(type="text_delta", data={"text": block["text"]})
                        elif block.get("type") == "tool_use":
                            yield AgentEvent(type="tool_use", data={
                                "id": block.get("id", ""),
                                "name": block.get("name", ""),
                                "input": block.get("input", {}),
                            })

            elif msg_type == "user" and "message" in event:
                msg = event["message"]
                if isinstance(msg, dict):
                    for block in msg.get("content", []):
                        if isinstance(block, dict) and block.get("type") == "tool_result":
                            yield AgentEvent(type="tool_result", data={
                                "tool_use_id": block.get("tool_use_id", ""),
                                "result": block.get("content", ""),
                            })

            # "result" event duplicates the final assistant text — skip it

    await proc.wait()
    try:
        os.unlink(mcp_config_path)
    except OSError:
        pass

    stderr_bytes = await stderr_task
    stderr = stderr_bytes.decode("utf-8", errors="replace")
    if stderr.strip():
        print(f"[CLI stderr]\n{stderr.strip()}", flush=True)
    if proc.returncode != 0 and stderr:
        yield AgentEvent(type="error", data={"message": f"claude CLI error: {stderr}"})

    yield AgentEvent(type="done", data={"stop_reason": "end", "provider": "cli"})


# ---------------------------------------------------------------------------
# Helpers
# ---------------------------------------------------------------------------


def _normalize_message(msg: dict[str, Any]) -> dict[str, Any]:
    """Ensure message is in Anthropic API format."""
    if "role" in msg and "content" in msg:
        content = msg["content"]
        if isinstance(content, dict):
            # Rich content dict: {text, file, selection} → flatten to string
            parts = []
            if file_name := content.get("file"):
                parts.append(f"[Active file: {file_name}]")
            if selection := content.get("selection"):
                parts.append(f"[Selected text]:\n{selection}")
            if text := content.get("text"):
                parts.append(text)
            return {"role": msg["role"], "content": "\n".join(parts)}
        return msg
    return {"role": "user", "content": str(msg)}
