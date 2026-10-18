import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

/**
 * Browser-only renderer dev server (`npm run dev:web`).
 *
 * The renderer's real config lives in `electron.vite.config.ts`, which plain
 * `vite` does not read — without this file `vite dev` served the repo root
 * (no index.html) and, once pointed at `src`, mounted the app with no
 * Tailwind and no path aliases. This mirrors the `renderer` block there so the
 * mock-API harness documented in CLAUDE.md actually renders.
 *
 * Keep the alias and plugin list in sync with electron.vite.config.ts.
 */
export default defineConfig({
  root: resolve(import.meta.dirname, 'src'),
  plugins: [react(), tailwindcss()],
  resolve: {
    dedupe: ['react', 'react-dom', 'zustand', 'luxon', 'cron-parser'],
    alias: {
      '@shared': resolve(import.meta.dirname, '../../libs/shared/src'),
      '@phosphor/shared': resolve(import.meta.dirname, '../../libs/shared/src'),
      '@': resolve(import.meta.dirname, '../../libs/client-ui/src'),
    },
  },
})
