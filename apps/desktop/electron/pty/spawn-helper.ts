import { repairSpawnHelper, spawnHelperDirs } from '@phosphor/session-runtime/spawn-helper'
import { dirname } from 'node:path'
import { createRequire } from 'node:module'

/**
 * Make node-pty's `spawn-helper` executable before the first PTY spawn.
 *
 * On POSIX, node-pty execs a tiny `spawn-helper` binary that sits next to the
 * native module it loaded. Its loader (`lib/utils.js`) tries
 * `build/Release` → `build/Debug` → `prebuilds/<platform>-<arch>` and takes
 * the first `pty.node` that `require()` accepts — so which directory the
 * helper is looked up in depends on which native build actually loaded.
 *
 * That is the trap: on Apple Silicon, a locally compiled `build/Release`
 * (which can easily be x86_64 — npm running under Rosetta, a mismatched
 * `electron-builder install-app-deps`) fails to load in an arm64 Electron and
 * the loader silently falls back to the shipped `prebuilds/darwin-arm64`,
 * whose `spawn-helper` npm unpacks as 0644. Missing the exec bit, every
 * `pty.spawn` throws `posix_spawnp failed.` — the terminal pane's shell never
 * starts, and nothing about the error says "chmod".
 *
 * Repairing every candidate directory (not just the one that loaded) is
 * deliberate: it keeps working if the arch
 * mismatch is fixed later and the loader starts preferring `build/Release`.
 * Best-effort by design — a packaged app on read-only media cannot chmod, and
 * a failure here must surface as the spawn error, not as a boot crash.
 */
export function ensureSpawnHelperExecutable(): void {
  let packageDir: string
  try {
    // node-pty has no exports map, so resolving package.json is the stable
    // way to find its root from the bundled main process.
    const require = createRequire(import.meta.url)
    packageDir = dirname(require.resolve('node-pty/package.json'))
  } catch {
    return
  }
  // asar cannot be exec'd from; electron-builder unpacks native deps, and
  // node-pty itself applies the same rewrite when computing the helper path.
  const roots = [packageDir, packageDir.replace('app.asar', 'app.asar.unpacked')]
  for (const root of new Set(roots)) {
    for (const dir of spawnHelperDirs) repairSpawnHelper(root, dir)
  }
}
