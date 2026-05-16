# Narrative Forge

AI-powered writing assistant for fiction authors, built as a standalone **Obsidian plugin**.

Write your chapters in Obsidian, ask questions in natural language — the AI reads your actual files and answers based on what's really in your story.

---

## Features

- **Local vector search** — semantic search across all scenes runs inside Obsidian using Orama + Transformers.js (WebAssembly ONNX model). Your text never leaves your device during indexing.
- **Incremental indexing** — only changed chapters are re-embedded on save. Large books (100+ chapters) re-index in under a second.
- **Read and edit chapters from chat** — the AI calls tools to read your files before answering, and edits them using precise line/character coordinates (LSP-style, like VS Code).
- **Write new scenes and create files** — append new scenes or create new character/location/world notes directly from chat.
- **Character and location profiles** — put profile files in `characters/` and `locations/`. The AI finds aliases, prepends a profile notice, and reads the full bio on request.
- **Timeline tracking** — mark in-world timestamps on chapters (`timeline:: Year 1, Day 15`). Ask the AI to set or list them across the whole book.
- **Consistency checking** — ask "does this contradict anything said in chapter 3?"
- **Story bible** — put world rules in `CLAUDE.md`, the AI follows them automatically.
- **Selection context** — highlight text in the editor, switch to chat, and the AI receives the selected passage as context.
- **Multi-provider** — Anthropic Claude, OpenAI, Google Gemini, or any local model via Ollama / LM Studio.

---

## Architecture

```
.md chapter files  (chapters/, characters/, locations/, world/, notes/)
       │
       ▼  (on save or manual import)
Transformers.js  ──  Xenova/all-MiniLM-L6-v2 (ONNX, runs in Obsidian)
       │
       ▼
Orama vector DB  ──  persisted to .narrative-orama.json in your vault
       │
       ▼
Local TS tools   ──  18 tools: search, read, edit, write, list, timeline
       │
       ▼
LLM provider     ──  Anthropic / OpenAI / Gemini / Ollama / LM Studio
       │
       ▼
Obsidian chat panel
```

The AI never guesses — it uses local tools to look up your book before generating a response.

---

## Requirements

- [Obsidian](https://obsidian.md) **1.5.11+** (desktop only)
- One of:
  - **Anthropic API key** (Claude) — [console.anthropic.com](https://console.anthropic.com)
  - **OpenAI API key** — [platform.openai.com](https://platform.openai.com)
  - **Google Gemini API key** — [aistudio.google.com](https://aistudio.google.com)
  - **[Ollama](https://ollama.com/)** or **[LM Studio](https://lmstudio.ai/)** for 100% free local inference

---

## Installation

> Once Narrative Forge is accepted into the [Obsidian Community Plugins directory](https://obsidian.md/plugins), the recommended install path will be **Settings → Community plugins → Browse → search "Narrative Forge"**. Until then, install manually:

### Step 1 — Build the plugin

You need Node.js 18+ installed.

```bash
git clone https://github.com/di2mot/Narrative-Forge-obsidian
cd Narrative-Forge-obsidian/obsidian-plugin
npm install
npm run build
```

This produces `main.js` in `obsidian-plugin/`.

### Step 2 — Copy to your vault

```bash
# Replace /path/to/your/vault with your actual vault location
mkdir -p "/path/to/your/vault/.obsidian/plugins/narrative-forge"
cp obsidian-plugin/main.js       "/path/to/your/vault/.obsidian/plugins/narrative-forge/"
cp obsidian-plugin/manifest.json "/path/to/your/vault/.obsidian/plugins/narrative-forge/"
cp obsidian-plugin/styles.css    "/path/to/your/vault/.obsidian/plugins/narrative-forge/"
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
| Anthropic (Claude) | Provider: `Anthropic`, paste API key | Recommended: `claude-opus-4-7` or `claude-sonnet-4-6` |
| OpenAI | Provider: `OpenAI`, paste API key | Recommended: `gpt-4o` |
| Google Gemini | Provider: `Gemini`, paste API key | Recommended: `gemini-1.5-pro-latest` |
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

### Local LLM setup (LM Studio)

1. Open LM Studio, load a model that supports tool calling (check the model card)
2. Go to **Local Server** tab and click **Start Server**
3. In Narrative Forge settings:
   - **Provider**: `Local LLM (Ollama, LM Studio)`
   - **Local Base URL**: `http://localhost:1234/v1`
   - **Model Name**: leave empty — LM Studio ignores this field and always uses the loaded model

### Embedding language

The plugin uses `Xenova/all-MiniLM-L6-v2` (English, ~90 MB, downloaded once) by default.
For non-English books, switch to **Multilingual** in settings to use `Xenova/paraphrase-multilingual-MiniLM-L12-v2` (~470 MB).

The model is downloaded on first import and cached in the browser's local storage. No API key required for indexing.

---

## Book setup

### Folder structure

Create this layout inside your vault:

```
My Book/
├── .narrative-book.json     ← created automatically by "Create new book" command
├── CLAUDE.md                ← story bible (read by AI on every message)
├── chapters/
│   ├── 01-opening.md
│   ├── 02-conflict.md
│   └── 03-resolution.md
├── characters/              ← one .md file per character (optional)
│   ├── Rey.md
│   └── Freya.md
├── locations/               ← one .md file per location (optional)
│   └── Ganymede Station.md
├── world/                   ← world-building notes (optional)
│   └── magic-system.md
└── notes/                   ← general notes (optional)
```

The AI reads from all of these folders. Profile files in `characters/` and `locations/` are matched against chapter mentions by name and alias — when the AI finds a character, it tells you if a profile exists and can read it on request.

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
| `timeline:: ...` | In-story timestamp — set with `add_timeline_marker`, listed with `list_timeline` |
| `characters:: Rey, Freya` | Characters present (also auto-detected from dialogue tags) |
| `[character: Name] — text` | Dialogue line — the AI formats new dialogue in this style automatically |
| `---` (alone on a line) | Scene break — starts a new scene, resets metadata |

Metadata fields are optional. A plain `.md` file with just prose works fine — the AI will still index and search it.

### Character profile format

```markdown
---
type: character
full_name: Rey Okafor
aliases: [Rey, Рей]
role: protagonist
status: alive
---

34-year-old Nigerian-Brazilian pilot. Dry humor. Never swears.
```

Place this in `characters/Rey Okafor.md`. The AI detects it when you ask about "Rey" (via alias matching) and prepends a profile notice with a link to the file.

### Location profile format

```markdown
---
type: location
full_name: Ganymede Station
aliases: [Ganymede, The Station]
location_type: space station
---

Neutral territory. No weapons allowed on the promenade.
```

Place this in `locations/Ganymede Station.md`.

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

### Selection context

Highlight any text in your editor, then open the chat — the selected text is automatically sent to the AI as context. You don't need to paste it manually.

### Available AI tools

The AI has 18 local tools it can call to work with your book:

| Tool | What it does |
|------|-------------|
| `list_chapters` | List all chapters with number, title, status, word count |
| `list_characters` | List all characters ranked by mentions; marks profile files |
| `list_locations` | List all locations from chapters + `locations/` profiles |
| `list_timeline` | List all in-world timestamps across chapters in order |
| `add_timeline_marker` | Set `timeline::` on a chapter by number or filename |
| `get_chapter` | Read a chapter by its `chapter:` frontmatter number |
| `read_chapter` | Read any chapter file with line numbers |
| `read_scene` | Read one scene from a chapter file |
| `read_note` | Read any profile or note file (characters/, locations/, world/, notes/) |
| `search_semantic` | Semantic similarity search across all scenes |
| `search_by_character` | Find every scene featuring a character; detects profile aliases |
| `search_by_location` | Find every scene at a location; detects profile aliases |
| `edit_scene` | Replace a line range in a file (LSP-style coordinates) |
| `write_scene` | Append a formatted scene block to a chapter |
| `append_to_chapter` | Append raw text to a chapter file |
| `create_note` | Create or overwrite any file (character profile, location, chapter, note) |
| `get_book_info` | Chapter count and indexing status |
| `reimport_book` | Trigger a re-index of the whole book |

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
```
Create a character profile for Велтурс — astronomer, specialist role.
```
```
Set the timeline for chapter 1 to "Year 1, Day 1".
```
```
Show me the world timeline.
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
- Not all local models support tool calling reliably. Tested and working: `qwen2.5`, `mistral-nemo`, `llama3.1`, `gemma-3`
- In LM Studio, make sure the loaded model has tool/function calling support enabled in the model card
- Increase the model's context window to at least 8192 tokens in LM Studio (Settings → Context Length)

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
git clone https://github.com/di2mot/Narrative-Forge-obsidian
cd Narrative-Forge-obsidian/obsidian-plugin
npm install

# Watch mode (rebuilds on file change)
npm run dev

# Production build
npm run build

# Auto-deploy to vault on build
NOS_VAULT_PLUGIN_DIR="/path/to/vault/.obsidian/plugins/narrative-forge" npm run build
```

### Project structure

```
obsidian-plugin/src/
├── main.ts         # Plugin entry point, lifecycle, commands
├── agent.ts        # LLM agent loop, tool schemas (18 tools), BASE_PROMPT
├── tools.ts        # LocalToolExecutor — all 18 local tools
├── database.ts     # VectorDatabase (Orama + Transformers.js)
├── importer.ts     # importBookLocally — incremental hash-based re-indexing
├── parser.ts       # .md chapter parser → Chapter/Scene types
├── chat.ts         # Chat panel UI, selection capture, streaming
├── sidebar.ts      # Sidebar UI (book info, import button)
├── settings.ts     # Settings tab and defaults
└── ...
```

### Testing

```bash
cd obsidian-plugin
npm test    # runs 74 unit tests via Vitest
```

Tests cover: chapter/character/location listing, hybrid DB-first → file-scan fallback, search tools, profile alias matching, create/read/update note operations, timeline marker insertion and listing.

---

## Optional: Python bridge (Claude Pro / Claude Code CLI)

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

MIT — see [LICENSE](../LICENSE).
