# Narrative Forge

AI-powered writing assistant for fiction authors, built as a standalone **Obsidian plugin**.

Write your chapters in Obsidian, ask questions in natural language — the AI reads your actual files and answers based on what's really in your story.

---

## Features

- **Local vector search** — semantic search across all scenes runs inside Obsidian using Orama + Transformers.js (WebAssembly ONNX model). Your text never leaves your device during indexing.
- **Incremental indexing** — only changed chapters are re-embedded on save. Large books (100+ chapters) re-index in under a second.
- **Read and edit chapters from chat** — the AI calls tools to read your files before answering, and edits them using precise line/character coordinates (LSP-style, like VS Code).
- **Write new scenes** — append new scenes with correct dialogue formatting directly from chat.
- **Character and location lookup** — find every scene a character appears in.
- **Consistency checking** — ask "does this contradict anything said in chapter 3?"
- **Story bible** — put world rules in `CLAUDE.md`, the AI follows them automatically.
- **Multi-provider** — Anthropic Claude, OpenAI, Google Gemini, or any local model via Ollama / LM Studio.

---

## Architecture

```
.md chapter files
       │
       ▼  (on save or manual import)
Transformers.js  ──  Xenova/all-MiniLM-L6-v2 (ONNX, runs in Obsidian)
       │
       ▼
Orama vector DB  ──  persisted to .narrative-orama.json in your vault
       │
       ▼
Local TS tools   ──  search_semantic, read_chapter, read_scene, edit_scene, write_scene
       │
       ▼
LLM provider     ──  Anthropic / OpenAI / Gemini / Ollama
       │
       ▼
Obsidian chat panel
```

The AI never guesses — it uses local tools to look up your book before generating a response.

---

## Requirements

- [Obsidian](https://obsidian.md) **1.0+** (desktop only)
- One of:
  - **Anthropic API key** (Claude) — [console.anthropic.com](https://console.anthropic.com)
  - **OpenAI API key** — [platform.openai.com](https://platform.openai.com)
  - **Google Gemini API key** — [aistudio.google.com](https://aistudio.google.com)
  - **[Ollama](https://ollama.com/)** or **[LM Studio](https://lmstudio.ai/)** for 100% free local inference

---

## Installation

### Step 1 — Build the plugin

You need Node.js 18+ installed.

```bash
git clone https://github.com/di2mot/narrative-os
cd narrative-os/obsidian-plugin
npm install
npm run build
```

This produces `main.js` in `obsidian-plugin/`.

### Step 2 — Copy to your vault

```bash
# Replace /path/to/your/vault with your actual vault location
mkdir -p "/path/to/your/vault/.obsidian/plugins/narrative-forge"
cp obsidian-plugin/main.js     "/path/to/your/vault/.obsidian/plugins/narrative-forge/"
cp obsidian-plugin/manifest.json "/path/to/your/vault/.obsidian/plugins/narrative-forge/"
cp obsidian-plugin/styles.css  "/path/to/your/vault/.obsidian/plugins/narrative-forge/"
```

**Tip:** Set `NOS_VAULT_PLUGIN_DIR` to auto-deploy on every build:
```bash
NOS_VAULT_PLUGIN_DIR="/path/to/your/vault/.obsidian/plugins/narrative-forge" npm run build
```

### Step 3 — Enable in Obsidian

1. Open Obsidian → **Settings** → **Community Plugins**
2. Turn off **Safe Mode** if prompted
3. Find **Narrative Forge** in the list and toggle it **on**
4. A new sidebar icon (book) and chat icon (message bubble) appear in the left ribbon

---

## Configuration

Open **Settings → Narrative Forge** to configure the plugin.

### Provider options

| Provider | Setting | Notes |
|----------|---------|-------|
| Anthropic (Claude) | Provider: `Anthropic`, paste API key | Recommended: `claude-opus-4-5` or `claude-sonnet-4-6` |
| OpenAI | Provider: `OpenAI`, paste API key | Recommended: `gpt-4o` |
| Google Gemini | Provider: `Gemini`, paste API key | Recommended: `gemini-2.5-pro` |
| Local (Ollama) | Provider: `Local LLM`, Base URL: `http://localhost:11434/v1` | Model must support tool calling |
| Local (LM Studio) | Provider: `Local LLM`, Base URL: `http://localhost:1234/v1` | Same requirement |

### Local LLM setup (Ollama)

```bash
# Install Ollama from https://ollama.com, then:
ollama pull llama3.1        # recommended for tool calling
# or
ollama pull qwen2.5         # good multilingual alternative
```

Make sure the Ollama server is running before opening Obsidian. Set:
- **Provider**: `Local LLM (Ollama, LM Studio)`
- **Local Base URL**: `http://localhost:11434/v1`
- **Model Name**: `llama3.1` (exact name as shown by `ollama list`)

### Embedding language

The plugin uses `Xenova/all-MiniLM-L6-v2` (English, ~400 MB, downloaded once) by default.
For non-English books, switch to **Multilingual** in settings to use `Xenova/multilingual-e5-small` (~500 MB).

The model is downloaded on first import and cached in Obsidian's local storage. No API key required for indexing.

---

## Book setup

### Folder structure

Create this layout inside your vault:

```
My Book/
├── .narrative-book.json   ← created automatically by "Create new book" command
├── chapters/
│   ├── 01-opening.md
│   ├── 02-conflict.md
│   └── 03-resolution.md
├── notes/
│   ├── characters.md      ← character profiles
│   ├── world.md           ← world building
│   └── timeline.md
└── CLAUDE.md              ← story bible (read by AI on every message)
```

### Creating a book

Use the command palette (`Ctrl/Cmd+P`) → **Narrative Forge: Create new book**. This creates `.narrative-book.json` with default settings and the required folder structure.

### Importing your book

**First-time import:**
1. Open the Narrative Forge sidebar (book icon in ribbon)
2. Click **Import book** or run command **Narrative Forge: Import book**
3. Obsidian downloads the embedding model (~400 MB) on first run — this takes 1–3 minutes depending on your connection
4. Your chapters are indexed and stored in `.narrative-orama.json`

**Automatic re-import:**
Enable **Auto-import on save** in settings. When you save a chapter file, only that file is re-indexed (incremental — unchanged chapters are skipped). The re-index completes in the background without freezing the UI.

**Force full re-import:**
Run **Narrative Forge: Import book** with the force option to clear the index and rebuild everything from scratch.

---

## Chapter format

Narrative Forge uses standard Markdown with a few lightweight conventions.

### Full example

```markdown
---
title: The Station
chapter: 1
status: draft
---

location:: Ganymede Station, Docking Bay 7
timeline:: Year 2187, Day 1, 06:00

The docking bay smelled of recycled air and machine oil.
Rey stepped off the transport and looked around.

[character: Rey] — Where are we?
[character: Freya] — Ganymede Station. Outer ring.

---
location:: Corridor B
timeline:: same day, 08:30

Two hours later they had their orders.
```

### Conventions

| Syntax | Meaning |
|--------|---------|
| YAML `---` frontmatter | Chapter metadata (`title`, `chapter`, `status`, `pov`, `word_target`) |
| `location:: ...` | Scene location — propagates to all scenes until the next `---` |
| `timeline:: ...` | In-story timestamp |
| `characters:: Rey, Freya` | Characters present (auto-detected from dialogue too) |
| `[character: Name] — text` | Dialogue line — the AI formats new dialogue in this style automatically |
| `---` (alone on a line) | Scene break — starts a new scene, resets metadata |

Metadata fields are optional. A plain `.md` file with just prose works fine — the AI will still index and search it.

---

## Story bible (CLAUDE.md)

Create a `CLAUDE.md` file in your book folder. The AI reads this file automatically at the start of every chat session.

Use it for:
- Character descriptions and backstory
- World rules and magic systems
- Tone and style guidelines
- Things the AI must never change or contradict
- Abbreviations and glossary

```markdown
# My Book — Story Bible

## Characters

**Rey Okafor** — 34, Nigerian-Brazilian pilot. Dry humor. Never swears.
**Freya Lund** — 28, Norwegian engineer. Speaks in technical jargon when nervous.

## World rules

- FTL travel exists but causes 3-day blackouts (no communication during transit)
- The year is 2187. Earth is governed by the Compact.
- Ganymede Station is neutral territory — no weapons allowed on the promenade

## Style

- Present tense, third-person limited (Rey's POV)
- Dialogue is terse. Characters interrupt each other.
- No adverbs in dialogue tags.
```

Any change to `CLAUDE.md` automatically invalidates the AI's prompt cache so it picks up the new rules immediately.

---

## Using the chat

Open the chat panel (message bubble icon in ribbon) or run **Narrative Forge: Open Chat**.

### Example prompts

```
What scenes does Freya appear in?
```
```
Read chapter 03 and summarize what happens.
```
```
Does anything in chapter 3 contradict what was established in chapter 1?
```
```
Edit the fight scene in chapter 2 — make Rey's dialogue shorter and more clipped.
```
```
Write a new scene at the end of chapter 4: Rey and Freya argue about the mission.
Format dialogue correctly and set location to "Engine Room".
```

### How editing works

When you ask the AI to edit text, it:
1. Calls `read_chapter` to see the file with **file-relative line numbers**
2. Identifies the exact line and character range to change
3. Calls `edit_scene` with `start_line`, `start_char`, `end_line`, `end_char` (LSP-style coordinates — same as VS Code)
4. The plugin applies the change directly to the `.md` file

This means edits are precise — a single wrong character no longer causes the whole edit to fail.

---

## Keyboard shortcuts

| Action | Default |
|--------|---------|
| Open Chat | None (assign in Obsidian hotkeys) |
| Open Sidebar | None |
| Import book | None |

Assign shortcuts in **Settings → Hotkeys** → search "Narrative Forge".

---

## Troubleshooting

### Model download fails / import hangs
- Check your internet connection — the embedding model (~400 MB) is downloaded from Hugging Face on first import
- Try disabling VPN if the download stalls
- Check the Obsidian developer console (`Ctrl+Shift+I`) for error messages

### "Chapters folder not found or empty"
- Make sure your chapters are in a `chapters/` subfolder inside the book root
- The book root must contain a `.narrative-book.json` file (created by the **Create new book** command)
- Open any chapter file before running import — the plugin detects the active book from the open file

### AI doesn't know about recent edits
- Enable **Auto-import on save** in settings
- Or manually run **Import book** after making changes

### Chat gives generic answers, ignores the story
- Make sure the import completed successfully (check sidebar for chapter count)
- Ask the AI to use `search_semantic` or `read_chapter` explicitly: "Read chapter 2 first, then answer..."
- Add key facts to `CLAUDE.md`

### Local LLM tool calling fails
- Not all local models support tool calling reliably. Use `llama3.1`, `qwen2.5`, or `mistral-nemo`
- Enable **Tools in system prompt** in settings if your model ignores function schemas
- Increase the model's context window to at least 8192 tokens in LM Studio / Ollama

### Build errors
```bash
# Clean install
rm -rf obsidian-plugin/node_modules
cd obsidian-plugin && npm install
npm run build
```

---

## Development

```bash
git clone https://github.com/di2mot/narrative-os
cd narrative-os/obsidian-plugin
npm install

# Watch mode (rebuilds on file change)
npm run dev

# Production build
npm run build

# Run unit tests
npm test

# Auto-deploy to vault on build
NOS_VAULT_PLUGIN_DIR="/path/to/vault/.obsidian/plugins/narrative-forge" npm run build
```

### Project structure

```
obsidian-plugin/src/
├── main.ts         # Plugin entry point, lifecycle, commands
├── agent.ts        # LLM agents (Anthropic / OpenAI / Gemini), tool schemas
├── tools.ts        # LocalToolExecutor — search, read, edit, write scene tools
├── database.ts     # VectorDatabase (Orama + Transformers.js)
├── importer.ts     # importBookLocally — incremental hash-based re-indexing
├── parser.ts       # .md chapter parser → Chapter/Scene types
├── chat.ts         # Chat panel UI
├── sidebar.ts      # Sidebar UI (book info, import button)
├── settings.ts     # Settings tab and defaults
├── backend.ts      # Optional Python backend manager
└── ...
```

### Running tests

```bash
cd obsidian-plugin && npm test
```

Tests cover pure logic only (hash utilities, LSP edit functions). Obsidian API integration is tested manually in Obsidian.

---

## Optional: Python bridge (Claude CLI / Claude Pro)

If you want to use your **Claude Pro subscription** via the Claude Code CLI instead of paying per-token for API calls, run the Python bridge:

```bash
# Install Python 3.11+, then:
pip install -e .

# Start the bridge (points at your book directory)
NOS_BOOK_DIR=/path/to/your/book uvicorn narrative_os.server:app --port 8000
```

In Obsidian Narrative Forge settings, set **Provider** to `Claude CLI`. The bridge proxies requests through Claude Code and executes local file tools via the plugin's built-in HTTP server (port 18000).

---

## License

AGPL-3.0
