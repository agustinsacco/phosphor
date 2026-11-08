import { defineConfig, externalizeDepsPlugin } from 'electron-vite'
import { resolve } from 'node:path'
import { pathToFileURL } from 'node:url'
import { rendererPlugins } from './renderer-plugins'

const repo = resolve(import.meta.dirname, '../..')

/**
 * Stages Brain's standalone pi extensions in libs/pi-extensions/brain-ext at
 * the start of every main build, dev or production: the resource root dev
 * sessions read and electron-builder's brain-ext source. Build-time only;
 * nothing at runtime imports the bundler, and staging enables nothing.
 */
function brainExtensions() {
  return {
    name: 'phosphor-brain-extensions',
    async buildStart() {
      const bundler = resolve(repo, 'tools/scripts/build-brain-extensions.mjs')
      const { buildBrainExtensions } = (await import(pathToFileURL(bundler).href)) as {
        buildBrainExtensions(options: { root: string; outDir: string }): Promise<void>
      }
      await buildBrainExtensions({
        root: repo,
        outDir: resolve(repo, 'libs/pi-extensions/brain-ext'),
      })
    },
  }
}

export default defineConfig({
  main: {
    plugins: [
      externalizeDepsPlugin({
        exclude: [
          '@phosphor/shared',
          '@phosphor/session-runtime',
          '@phosphor/host-client',
          '@phosphor/memory-engine',
          '@phosphor/brain-runtime',
        ],
      }),
      brainExtensions(),
    ],
    resolve: {
      alias: {
        '@shared': resolve(import.meta.dirname, '../../libs/shared/src'),
        '@phosphor/shared': resolve(import.meta.dirname, '../../libs/shared/src'),
        '@phosphor/session-runtime': resolve(import.meta.dirname, '../../libs/session-runtime/src'),
        '@phosphor/host-client': resolve(import.meta.dirname, '../../libs/host-client/src'),
        '@phosphor/memory-engine': resolve(import.meta.dirname, '../../libs/memory-engine/src'),
        '@phosphor/brain-runtime': resolve(import.meta.dirname, '../../libs/brain-runtime/src'),
      },
    },
    build: {
      lib: {
        entry: {
          main: 'electron/main.ts',
          // The voice utility process (electron/voice/index.ts forks it).
          'voice-worker': 'electron/voice/worker.ts',
          // The Brain embedding utility process (electron/brain/embedding-service.ts forks it).
          'brain-embedding-worker': 'electron/brain/embedding-worker.ts',
        },
      },
    },
  },
  preload: {
    plugins: [
      externalizeDepsPlugin({
        exclude: ['@phosphor/shared', '@phosphor/session-runtime', '@phosphor/host-client'],
      }),
    ],
    resolve: {
      alias: {
        '@shared': resolve(import.meta.dirname, '../../libs/shared/src'),
        '@phosphor/shared': resolve(import.meta.dirname, '../../libs/shared/src'),
        '@phosphor/session-runtime': resolve(import.meta.dirname, '../../libs/session-runtime/src'),
        '@phosphor/host-client': resolve(import.meta.dirname, '../../libs/host-client/src'),
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
    plugins: rendererPlugins(),
    resolve: {
      // Source libraries sit outside the app install domain. Keep their JS
      // dependencies on the app's copies rather than bundling a second copy.
      dedupe: ['react', 'react-dom', 'zustand', 'luxon', 'cron-parser'],
      alias: {
        '@shared': resolve(import.meta.dirname, '../../libs/shared/src'),
        '@phosphor/shared': resolve(import.meta.dirname, '../../libs/shared/src'),
        '@': resolve(import.meta.dirname, '../../libs/client-ui/src'),
      },
    },
    build: {
      rollupOptions: { input: resolve(import.meta.dirname, 'src/index.html') },
    },
  },
})
