import { execFileSync } from 'node:child_process'
import { copyFile, cp } from 'node:fs/promises'
import { resolve } from 'node:path'
import { evidence } from '../playwright.config'

export default async function setup() {
  const root = resolve(import.meta.dirname, '../../..')
  execFileSync(process.execPath, ['apps/host/scripts/build.mjs'], { cwd: root, stdio: 'pipe' })
  // Each build runs in its own process: one Node heap holding both builds outgrew the
  // 4 GB CI allows (NODE_OPTIONS is inherited, so each build gets that limit alone).
  const vite = (...args: string[]) =>
    execFileSync(
      process.execPath,
      [resolve(root, 'node_modules/vite/bin/vite.js'), 'build', ...args],
      // Inherit: warnings stay visible as before, and a pipe would cap them at 1 MB.
      { cwd: root, stdio: 'inherit' },
    )
  // Also build the unmodified production bootstrap; its smoke test never injects a socket.
  vite('apps/web', '--config', 'apps/web/vite.config.ts', '--logLevel', 'warn')
  vite('--config', 'apps/web/e2e/fixture.vite.config.ts')
  // The production worker shares notification helpers with its app entry. Keep its
  // hashed imports too: the transport-mapped app has a different asset graph.
  await cp(resolve(root, 'apps/web/dist/assets'), resolve(evidence, 'fixture-build/assets'), {
    recursive: true,
  })
  await copyFile(resolve(root, 'apps/web/dist/sw.js'), resolve(evidence, 'fixture-build/sw.js'))
}
