# Narrative Forge

AI assistant for fiction writers, embedded inside Obsidian. Search and edit your book with Claude, GPT, Gemini, or local LLMs (Ollama, LM Studio) — without your prose ever leaving your machine for indexing.

## Features

- **Side-panel chat** that knows your book. Ask "what color was Freya's coat in chapter 3?" — the AI reads the actual chapter, no hallucinations.
- **Multi-LLM provider** support: Anthropic, OpenAI, Gemini, Claude CLI, or any OpenAI-compatible local server (Ollama, LM Studio).
- **Local multilingual semantic search** via Orama + `@huggingface/transformers` running in WebAssembly. Default model `paraphrase-multilingual-MiniLM-L12-v2` works for non-English text (Ukrainian, Russian, Spanish, Mandarin, etc.).
- **Tool-using agent** with read/edit/write tools — the AI can edit specific scenes by line/char coordinates, append new scenes, search across chapters.
- **Standard Markdown + YAML frontmatter** — your `.md` files stay your `.md` files. Dialogue uses `[character: Name] — Text.` format.
- **Story bible** — put world rules in `CLAUDE.md` next to your chapters; the AI follows them automatically.
- **BYOK** — your own API key, or zero keys with a local model.

## Install

> Once accepted into the [Obsidian Community Plugins directory](https://obsidian.md/plugins), install via **Settings → Community plugins → Browse → "Narrative Forge"**. Until then, install manually:

### Manually (BRAT or git clone)

1. Clone or download this repository.
2. Run `cd obsidian-plugin && npm install && npm run build`.
3. Copy the resulting `obsidian-plugin/` folder (containing `main.js`, `manifest.json`, `styles.css`) into `<your-vault>/.obsidian/plugins/narrative-forge/`.
4. In Obsidian: Settings → Community plugins → enable Narrative Forge.

### From a release

Download `main.js`, `manifest.json`, and `styles.css` from the [latest release](https://github.com/di2mot/Narrative-Forge-obsidian/releases) and place them in `<your-vault>/.obsidian/plugins/narrative-forge/`.

## Configure

Open Settings → Narrative Forge:

- **Provider** — Claude CLI, Anthropic, OpenAI, Gemini, or Local LLM. Add your API key for paid providers, or set the Local Base URL for Ollama (`http://localhost:11434/v1`) or LM Studio (`http://localhost:1234/v1`).
- **Embedding model** — English-only (faster) or Multilingual (default; best for non-English authors).
- **Auto-import on save** — re-embed changed chapters when you save a `.md` file.

## Use

1. Open or create a book folder containing a `.narrative-book.json` marker (or use the "Create new book" command).
2. Run "Narrative Forge: Import book" once to index existing chapters.
3. Open the chat panel from the ribbon icon.
4. Ask questions, request edits, or generate new scenes. Right-click selected text → "Send to chat" to discuss a passage.

## File format

One file per chapter, in `chapters/`. YAML frontmatter:

```yaml
---
chapter: 1
title: The Arrival
location: Niflheim Station
timeline: Year 1105
characters: [Rey, Freya]
pov: Rey
status: draft
word_target: 5000
---
```

Dialogue:

```
[character: Rey] — Where are we?
[character: Freya] — I don't know. But this isn't Ganymede.
```

Scene breaks: `---` between scenes; you can override `location::` / `timeline::` on a per-scene basis using Dataview-style inline metadata.

## Privacy

- **Embeddings always run locally.** Your prose is never sent to any server during indexing or semantic search.
- **Chat:** with the local provider, nothing leaves your machine. With Anthropic / OpenAI / Gemini, only the chat messages and the scene snippets the AI fetches go to that provider — same trust model as any BYOK chat.

## Compatibility

Desktop only — uses Node.js fetch and WASM workarounds that mobile Obsidian doesn't support.

## License

MIT — see [LICENSE](../LICENSE).
