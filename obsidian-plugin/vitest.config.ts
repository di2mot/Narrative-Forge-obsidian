import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    environment: 'node',
    include: ['tests/**/*.test.ts'],
  },
  resolve: {
    alias: {
      obsidian: new URL('./tests/__mocks__/obsidian.ts', import.meta.url).pathname,
      './database': new URL('./tests/__mocks__/database.ts', import.meta.url).pathname,
    },
  },
});
