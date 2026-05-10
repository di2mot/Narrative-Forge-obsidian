// Mock database for testing.
// All methods return empty by default so the hybrid tools fall through to
// their file-scan path. Individual tests can override these to exercise the
// DB-first branch.
export const vectorDb = {
  searchSemantic: async () => [] as any[],
  searchByMetadata: async () => [] as any[],
  listChapters: async () => [] as any[],
  listCharacters: async () => [] as string[],
  init: async () => {},
};

export function resolveEmbeddingModel() {
  return null;
}
