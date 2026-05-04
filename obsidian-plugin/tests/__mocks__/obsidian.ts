// Mock Obsidian API for testing
export class App {}
export class TFile {}
export class FileSystemAdapter {}

/**
 * Minimal YAML parser for test mocks. Handles the subset used by
 * parser.ts frontmatter: scalar values, quoted strings, numbers, and
 * inline arrays like `[a, b, "c"]`. Sufficient for chapter frontmatter.
 */
export function parseYaml(text: string): Record<string, unknown> | null {
  const out: Record<string, unknown> = {};
  if (!text) return out;
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, "").trimEnd();
    if (!line.trim()) continue;
    const m = line.match(/^([A-Za-z_][\w-]*)\s*:\s*(.*)$/);
    if (!m) continue;
    out[m[1]] = parseValue(m[2].trim());
  }
  return out;
}

function parseValue(raw: string): unknown {
  if (raw === "" || raw === "~" || raw === "null") return null;
  if (raw === "true") return true;
  if (raw === "false") return false;
  if (/^-?\d+$/.test(raw)) return Number(raw);
  if (/^-?\d+\.\d+$/.test(raw)) return Number(raw);
  if (raw.startsWith("[") && raw.endsWith("]")) {
    const inner = raw.slice(1, -1).trim();
    if (!inner) return [];
    return inner.split(",").map((s) => parseScalar(s.trim()));
  }
  return parseScalar(raw);
}

function parseScalar(s: string): unknown {
  if ((s.startsWith('"') && s.endsWith('"')) || (s.startsWith("'") && s.endsWith("'"))) {
    return s.slice(1, -1);
  }
  return s;
}
