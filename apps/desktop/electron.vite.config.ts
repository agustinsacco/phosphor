import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({ exclude: ['@phosphor/shared', '@phosphor/session-runtime'] }),
    ],
    resolve: {
      alias: {
        '@shared': resolve(import.meta.dirname, '../../libs/shared/src'),
        '@phosphor/shared': resolve(import.meta.dirname, '../../libs/shared/src'),
        '@phosphor/session-runtime': resolve(import.meta.dirname, '../../libs/session-runtime/src'),
      },
    },
    build: {
      lib: {
        entry: {
          main: 'electron/main.ts',
          // The voice utility process (electron/voice/index.ts forks it).
          'voice-worker': 'electron/voice/worker.ts',
        },
      },
    },
  },
  preload: {
    plugins: [
      externalizeDepsPlugin({ exclude: ['@phosphor/shared', '@phosphor/session-runtime'] }),
    ],
    resolve: {
      alias: {
        '@shared': resolve(import.meta.dirname, '../../libs/shared/src'),
        '@phosphor/shared': resolve(import.meta.dirname, '../../libs/shared/src'),
        '@phosphor/session-runtime': resolve(import.meta.dirname, '../../libs/session-runtime/src'),
      },
    },
    build: {
      lib: { entry: 'electron/preload.ts' },
      rollupOptions: {
        output: {
          // Sandboxed preload scripts must be CommonJS.
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    root: 'src',
    plugins: [react(), tailwindcss()],
    resolve: {
      // Source libraries sit outside the app install domain. Keep their JS
      // dependencies on the app's copies rather than bundling a second copy.
      dedupe: ['luxon', 'cron-parser'],
      alias: {
        '@shared': resolve(import.meta.dirname, '../../libs/shared/src'),
        '@phosphor/shared': resolve(import.meta.dirname, '../../libs/shared/src'),
        '@': resolve(import.meta.dirname, 'src'),
      },
    },
    build: {
      rollupOptions: { input: resolve(import.meta.dirname, 'src/index.html') },
    },
  },
})
