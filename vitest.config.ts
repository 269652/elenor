import path from 'path';
import { defineConfig } from 'vitest/config';

// The app uses the "@/*" -> "./*" path alias (tsconfig.json), and engine/, ai/, etc. all rely
// on it internally — Vitest doesn't read tsconfig `paths` on its own, so it's mirrored here.
export default defineConfig({
  resolve: {
    alias: {
      '@': path.resolve(__dirname, '.'),
    },
  },
});
