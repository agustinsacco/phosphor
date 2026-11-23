#!/usr/bin/env node
/**
 * Restore the executable bit on node-pty's `spawn-helper` after install.
 *
 * node-pty execs this helper for every PTY it opens, and it looks for it next
 * to whichever `pty.node` actually loaded — `build/Release` if the local
 * compile worked, otherwise the shipped `prebuilds/<platform>-<arch>`. npm
 * unpacks the prebuilt helper as 0644, so any fall-through to `prebuilds`
 * (very easy on Apple Silicon: an x86_64 `build/Release` cannot load in an
 * arm64 Electron) makes every `pty.spawn` fail with the wonderfully opaque
 * `posix_spawnp failed.` and the terminal pane never gets a shell.
 *
 * Running this from `postinstall` fixes fresh clones; `electron/pty/
 * spawn-helper.ts` repeats it at runtime for installs that predate this script
 * and for packaged builds.
 */
import { URL } from 'node:url'
import { chmodSync, existsSync, statSync } from 'node:fs'
import { createRequire } from 'node:module'
import { dirname, join } from 'node:path'

let packageDir
try {
  packageDir = dirname(
    createRequire(new URL('../../apps/desktop/package.json', import.meta.url)).resolve(
      'node-pty/package.json',
    ),
  )
} catch {
  // node-pty is a hard dependency, but a partial install shouldn't fail the
  // whole postinstall chain.
  process.exit(0)
}

const candidates = [
  'build/Release',
  'build/Debug',
  `prebuilds/${process.platform}-${process.arch}`,
].map((dir) => join(packageDir, dir, 'spawn-helper'))

for (const helper of candidates) {
  try {
    if (!existsSync(helper)) continue
    const mode = statSync(helper).mode & 0o777
    if (mode & 0o111) continue
    chmodSync(helper, mode | 0o755)
    console.log(`fix-node-pty: chmod +x ${helper}`)
  } catch (error) {
    console.warn(`fix-node-pty: could not chmod ${helper}: ${error.message}`)
  }
}
