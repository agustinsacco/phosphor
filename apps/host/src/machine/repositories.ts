import { realpath, stat } from 'node:fs/promises'
import { isAbsolute, sep } from 'node:path'
import { errorText } from '@phosphor/shared/errors'
import { fail, info, pass, warn, type Check } from '../checks'
import { errnoIs, isInside } from '../fs-safety'
import { probe, type ProbeEnvironment } from './probe'

/**
 * Is `candidate` the root itself or inside it? Both must be real paths.
 * The legacy candidate-first order of `isInside`, which compares paths as
 * written, trailing separators included.
 */
export function isInsideRoot(candidate: string, root: string): boolean {
  return isInside(root, candidate)
}

/**
 * The real path of `candidate` when it lies inside a configured root, else
 * null. Resolving first means `..`, a symlink that escapes, and `/repo2`
 * against `/repo` all fail. `roots` are the real paths `checkRepositories`
 * returns.
 */
export async function confineToRoots(
  candidate: string,
  roots: readonly string[],
): Promise<string | null> {
  if (!isAbsolute(candidate)) return null
  try {
    const real = await realpath(candidate)
    return roots.some((root) => isInsideRoot(real, root)) ? real : null
  } catch {
    return null
  }
}

/**
 * Resolve the configured roots. Each must be an existing folder other than
 * `/`. A root that holds the home folder, or sits one level under `/`, is
 * allowed with a warning: a session could then run almost anywhere.
 */
export async function checkRepositories(
  configured: readonly string[],
  machine: { home: string; git: string | null; environment: ProbeEnvironment },
): Promise<{ roots: string[]; checks: Check[] }> {
  const home = await realpath(machine.home).catch(() => machine.home)
  const roots: string[] = []
  const checks: Check[] = configured.length
    ? []
    : [info('repository', 'no folders configured; add one with the Desktop folder picker')]
  for (const path of configured) {
    let real: string
    try {
      real = await realpath(path)
      if (!(await stat(real)).isDirectory()) {
        checks.push(fail('repository', `${path} is not a folder`))
        continue
      }
    } catch (error) {
      const missing = errnoIs(error, 'ENOENT')
      checks.push(fail('repository', `${path} ${missing ? 'does not exist' : errorText(error)}`))
      continue
    }
    if (real === sep) {
      checks.push(fail('repository', `${path} resolves to /`))
      continue
    }
    if (roots.includes(real)) continue
    roots.push(real)
    const isGit =
      machine.git !== null &&
      (await probe(machine.git, ['-C', real, 'rev-parse', '--git-dir'], machine.environment))
        .code === 0
    const broad = isInsideRoot(home, real) || real.split(sep).length <= 2
    const summary =
      (real === path ? path : `${path} (${real})`) +
      (isGit
        ? ', a git repository'
        : ', not a git repository: sessions may start in any folder inside it') +
      (broad ? '; very broad, so a session could run almost anywhere' : '')
    checks.push(
      broad
        ? warn('repository', summary)
        : isGit
          ? pass('repository', summary)
          : info('repository', summary),
    )
  }
  return { roots, checks }
}
