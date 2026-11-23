import { resolve } from 'node:path'
import config from '../vite.config'
import { evidence } from '../playwright.config'

/** The transport-mapped fixture app the browser specs load; built by `build.ts`. */
export default {
  ...config,
  root: resolve(import.meta.dirname, 'client'),
  publicDir: resolve(import.meta.dirname, '../public'),
  logLevel: 'warn' as const,
  build: {
    outDir: resolve(evidence, 'fixture-build'),
    emptyOutDir: true,
    rollupOptions: { input: resolve(import.meta.dirname, 'client/index.html') },
  },
}
