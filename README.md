# Narrative Forge

AI-powered writing assistant for fiction authors, built as an Obsidian plugin.

Write your chapters in Obsidian, ask questions in natural language — the AI reads your actual files and answers based on what's really in your story.

## What it does

- **Semantic search** across all scenes and chapters
- **Character and location lookup** — find every scene a character appears in
- **Read and edit chapter files** directly from chat
- **Write new scenes and dialogue** with correct formatting, appended to chapter files
- **Consistency checking** — ask "does this contradict anything earlier?"
- **Story bible** — put your world rules in `CLAUDE.md`, the AI follows them automatically

## Architecture

```
.md chapter files  →  parser  →  ChromaDB (vector index)
                                       ↓
                              MCP tools (search, read, edit)
                                       ↓
                         Claude (via CLI or Anthropic API)
                                       ↓
                              Obsidian chat panel
```

Authors write in plain Markdown. The AI never guesses — it uses tools to look up information in the indexed files.

## Requirements

- [Obsidian](https://obsidian.md) 1.0+
- Python 3.11+
- [Claude Code CLI](https://docs.anthropic.com/en/docs/claude-code) with active subscription **or** Anthropic API key

## Installation

### 1. Install the Python backend

```bash
pip install narrative-forge
```

Or from source:

```bash
git clone https://github.com/di2mot/Narrative-Forge-obsidian
cd Narrative-Forge-obsidian
pip install -e .
```

### 2. Start the backend

```bash
NOS_BOOK_DIR=/path/to/your/book uvicorn narrative_os.server:app --port 8000
```

### 3. Install the Obsidian plugin

1. Copy the `obsidian-plugin/` folder to your vault's `.obsidian/plugins/narrative-forge/`
2. Enable **Narrative Forge** in Obsidian → Settings → Community Plugins
3. Configure the backend URL in plugin settings (default: `http://localhost:8000`)

### 4. Set up your book

Create a folder structure in your vault:

```
My Book/
├── chapters/
│   ├── 01-opening.md
│   └── 02-conflict.md
├── notes/
│   └── general.md       ← world notes, also indexed
└── CLAUDE.md            ← story bible (characters, world rules, lore)
```

Click **Import** in the Narrative Forge sidebar to index your book.

## Chapter format

Narrative Forge uses standard Markdown with a few conventions:

```markdown
# Chapter Title
location:: The Station
timeline:: Day 1, morning
characters:: Rey, Freya

Narrative text here.

[character: Rey] — Where are we?
[character: Freya] — I don't know. But this isn't Ganymede.

---
location:: Corridor B
timeline:: later that day

Scene after a break.
```

- `location::` / `timeline::` / `characters::` — metadata tags
- `[character: Name] — text` — dialogue
- `---` — scene break

## AI providers

| Provider | How to use |
|---|---|
| Claude Code CLI | Install `claude` CLI, log in with Claude Pro subscription. Set `NOS_AGENT_PROVIDER=cli` (default). |
| Anthropic API | Set `ANTHROPIC_API_KEY`. Set `NOS_AGENT_PROVIDER=api`. |

## Environment variables

| Variable | Default | Description |
|---|---|---|
| `NOS_AGENT_PROVIDER` | `cli` | `cli` or `api` |
| `ANTHROPIC_API_KEY` | — | Required for `api` provider |
| `NOS_LANGUAGE` | `uk` | Embedding model language (`en` or `uk`/multilingual) |

## Development

```bash
git clone https://github.com/di2mot/Narrative-Forge-obsidian
cd Narrative-Forge-obsidian
python -m venv .venv && source .venv/bin/activate
pip install -e ".[dev]"
python -m pytest tests/ -v
```

Build the Obsidian plugin:

```bash
cd obsidian-plugin
npm install
npm run build
# Optional: set NOS_VAULT_PLUGIN_DIR to auto-deploy to your vault
NOS_VAULT_PLUGIN_DIR="/path/to/vault/.obsidian/plugins/narrative-forge" npm run build
```

## License

AGPL-3.0
