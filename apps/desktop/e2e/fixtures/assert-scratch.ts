import { realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, join, relative } from 'node:path'

/**
 * The suite-level guard for the local-daemon specs: every root a test hands
 * the daemon or Desktop (userData, pi's agent dir, the daemon's config and
 * state, its socket, the LaunchAgents folder its HOME implies) must resolve
 * inside a scratch folder the test created. One root outside fails the test
 * before anything could be written there, because the owner's live app and
 * this Mac's CI runner share the real ones.
 */

/** `path` with symlinks resolved, through its deepest existing ancestor when it does not exist yet. */
export function resolveRoot(path: string): string {
  const missing: string[] = []
  let current = path
  for (;;) {
    try {
      return join(realpathSync.native(current), ...missing.reverse())
    } catch {
      const parent = dirname(current)
      if (parent === current) return path
      missing.push(basename(current))
      current = parent
    }
  }
}

const strictlyInside = (folder: string, path: string) => {
  const rel = relative(folder, path)
  return rel !== '' && !rel.startsWith('..') && !isAbsolute(rel)
}

/** One line per root that is relative, or resolves outside every scratch folder or under HOME. */
export function scratchViolations(
  roots: Readonly<Record<string, string>>,
  scratch: readonly string[],
  home = homedir(),
): string[] {
  const folders = scratch.map(resolveRoot)
  const realHome = resolveRoot(home)
  const violations: string[] = []
  for (const [name, path] of Object.entries(roots)) {
    if (!isAbsolute(path)) {
      violations.push(`${name}: ${path} is not absolute`)
      continue
    }
    const real = resolveRoot(path)
    if (!folders.some((folder) => strictlyInside(folder, real)))
      violations.push(`${name}: ${real} is outside scratch`)
    // Fails closed when TMPDIR itself lives under HOME.
    else if (real === realHome || strictlyInside(realHome, real))
      violations.push(`${name}: ${real} is under the real home folder`)
  }
  return violations
}

/** Throws, naming every offender, unless every root resolves inside `scratch`. */
export function assertScratchRoots(
  roots: Readonly<Record<string, string>>,
  scratch: readonly string[],
): void {
  const violations = scratchViolations(roots, scratch)
  if (violations.length > 0)
    throw new Error(`Refusing to run outside scratch:\n${violations.join('\n')}`)
}
