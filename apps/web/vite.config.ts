import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { resolve } from 'node:path'
import { assertBrowserModule } from './build-policy'

const root = resolve(import.meta.dirname, '../..')
const buildId = process.env.PHOSPHOR_BUILD_SHA ?? 'local'
if (buildId !== 'local' && !/^[a-f0-9]{40}$/.test(buildId)) throw new Error('Invalid web build SHA')
export default defineConfig({
  plugins: [
    react(),
    tailwindcss(),
    {
      name: 'browser-boundary',
      generateBundle() {
        for (const id of this.getModuleIds()) {
          try {
            assertBrowserModule(id)
          } catch (error) {
            throw new Error(
              `${String(error)}; importers: ${this.getModuleInfo(id)
                ?.importers.flatMap((parent) => this.getModuleInfo(parent)?.importers ?? [parent])
                .join(', ')}`,
              { cause: error },
            )
          }
        }
      },
    },
  ],
  define: { __WEB_BUILD_ID__: JSON.stringify(buildId) },
  resolve: {
    dedupe: ['react', 'react-dom', 'zustand', 'luxon', 'cron-parser'],
    alias: {
      // The package barrel also loads its Node-only file reader. Use the same
      // parser class directly, without shipping fs stubs to the browser.
      'cron-parser': resolve(root, 'node_modules/cron-parser/dist/CronExpressionParser.js'),
      '@': resolve(root, 'libs/client-ui/src'),
      '@shared': resolve(root, 'libs/shared/src'),
      '@phosphor/shared': resolve(root, 'libs/shared/src'),
      '@phosphor/host-client': resolve(root, 'libs/host-client/src'),
    },
  },
  build: {
    rollupOptions: {
      input: {
        app: resolve(import.meta.dirname, 'index.html'),
        sw: resolve(import.meta.dirname, 'src/service-worker.ts'),
      },
      output: {
        entryFileNames: (chunk) => (chunk.name === 'sw' ? 'sw.js' : 'assets/[name]-[hash].js'),
      },
    },
  },
})
