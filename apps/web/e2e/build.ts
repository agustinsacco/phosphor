import { build } from 'vite'
import { execFileSync } from 'node:child_process'
import { copyFile, cp } from 'node:fs/promises'
import { resolve } from 'node:path'
import config from '../vite.config'
import { evidence } from '../playwright.config'

export default async function setup() {
  const root = resolve(import.meta.dirname, '../../..')
  execFileSync(process.execPath, ['apps/host/scripts/build.mjs'], { cwd: root, stdio: 'pipe' })
  // Also build the unmodified production bootstrap; its smoke test never injects a socket.
  await build({
    configFile: resolve(root, 'apps/web/vite.config.ts'),
    root: resolve(root, 'apps/web'),
    logLevel: 'warn',
  })
  await build({
    ...config,
    configFile: false,
    root: resolve(import.meta.dirname, 'client'),
    publicDir: resolve(root, 'apps/web/public'),
    logLevel: 'warn',
    build: {
      outDir: resolve(evidence, 'fixture-build'),
      emptyOutDir: true,
      rollupOptions: { input: resolve(import.meta.dirname, 'client/index.html') },
    },
  })
  // The production worker shares notification helpers with its app entry. Keep its
  // hashed imports too: the transport-mapped app has a different asset graph.
  await cp(resolve(root, 'apps/web/dist/assets'), resolve(evidence, 'fixture-build/assets'), {
    recursive: true,
  })
  await copyFile(resolve(root, 'apps/web/dist/sw.js'), resolve(evidence, 'fixture-build/sw.js'))
}
