import { defineConfig } from 'vite'
import { resolve } from 'node:path'
import { rendererPlugins } from './renderer-plugins'

/**
 * Browser-only renderer dev server (`npm run dev:web`).
 *
 * The renderer's real config lives in `electron.vite.config.ts`, which plain
 * `vite` does not read — without this file `vite dev` served the repo root
 * (no index.html) and, once pointed at `src`, mounted the app with no
 * Tailwind and no path aliases. This mirrors the `renderer` block there so the
 * mock-API harness documented in AGENTS.md actually renders.
 *
 * Keep the aliases in sync with electron.vite.config.ts; both take their
 * plugins from `renderer-plugins.ts`.
 */
export default defineConfig({
  root: resolve(import.meta.dirname, 'src'),
  plugins: rendererPlugins(),
  resolve: {
    dedupe: ['react', 'react-dom', 'zustand', 'luxon', 'cron-parser'],
    alias: {
      '@shared': resolve(import.meta.dirname, '../../libs/shared/src'),
      '@phosphor/shared': resolve(import.meta.dirname, '../../libs/shared/src'),
      '@': resolve(import.meta.dirname, '../../libs/client-ui/src'),
    },
  },
})
