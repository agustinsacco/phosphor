import { mkdirSync, readdirSync, statSync } from 'node:fs'
import { basename, dirname, join, resolve } from 'node:path'
import type { SandboxInfo } from '@shared/models'

/**
 * Sandbox folders back the "No folder" option: a session that belongs to no
 * project still needs a real cwd for pi, so we mint one under the app's own
 * data dir (`<userData>/sandboxes/sandbox-N`). From then on it is an ordinary
 * workspace — it enters recents and hosts any number of sessions.
 *
 * The base is injected rather than read from `app` here so this module stays
 * importable in tests without mocking electron, and so E2E runs (which
 * redirect userData via PHOSPHOR_TEST_USER_DATA) never write into the real one.
 */

const SANDBOX_NAME = /^sandbox-(\d+)$/

/** The next free `sandbox-N` name, counting only names of exactly that shape. */
export function nextSandboxName(existing: string[]): string {
  let max = 0
  for (const name of existing) {
    const match = SANDBOX_NAME.exec(name)
    if (match) max = Math.max(max, Number(match[1]))
  }
  return `sandbox-${max + 1}`
}

/**
 * Every sandbox under `base`, most recently touched first.
 *
 * `itemCount` ignores dotfiles: Finder drops a `.DS_Store` into any folder it
 * looks at, and a sandbox holding nothing but that is still untouched as far
 * as the user is concerned.
 */
export function listSandboxFolders(base: string): SandboxInfo[] {
  let names: string[]
  try {
    names = readdirSync(base, { withFileTypes: true })
      .filter((entry) => entry.isDirectory() && SANDBOX_NAME.test(entry.name))
      .map((entry) => entry.name)
  } catch {
    return [] // No sandbox has ever been created.
  }

  const sandboxes: SandboxInfo[] = []
  for (const name of names) {
    const path = join(base, name)
    try {
      const itemCount = readdirSync(path).filter((entry) => !entry.startsWith('.')).length
      sandboxes.push({ path, name, itemCount, lastUsedAt: statSync(path).mtimeMs })
    } catch {
      // Vanished between the two reads (a concurrent delete); skip it.
    }
  }
  return sandboxes.sort((a, b) => b.lastUsedAt - a.lastUsedAt)
}

/** Create `<base>/sandbox-N` (N = one past the highest) and return its path. */
export function createSandboxFolder(base: string): string {
  mkdirSync(base, { recursive: true })
  const path = join(base, nextSandboxName(readdirSync(base)))
  mkdirSync(path)
  return path
}

/**
 * The folder "No folder" should open.
 *
 * An empty sandbox is handed out again rather than replaced. Minting one per
 * click was the original design — scratch space per task — but a sandbox only
 * fills up if the model writes to it, so asking twice in a row left an empty
 * folder behind in the sidebar every time. Reuse costs nothing (there are no
 * files to mix) and the moment a sandbox holds real work the next ask mints a
 * fresh one.
 */
export function openSandboxFolder(base: string): string {
  const reusable = listSandboxFolders(base).find((sandbox) => sandbox.itemCount === 0)
  return reusable ? reusable.path : createSandboxFolder(base)
}

/**
 * Deletion guard: the resolved path, or null when it is not a `sandbox-N`
 * folder directly inside `base`.
 *
 * Deleting is the one sandbox operation that takes a path FROM the renderer,
 * so the main process re-derives what is legal instead of trusting it. Purely
 * lexical, so it is testable without a filesystem — the caller still has to
 * cope with the folder being gone.
 */
export function resolveSandboxFolder(base: string, path: string): string | null {
  const target = resolve(path)
  if (dirname(target) !== resolve(base)) return null
  return SANDBOX_NAME.test(basename(target)) ? target : null
}
