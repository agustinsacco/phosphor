import { existsSync, readFileSync } from 'node:fs'
import { basename, isAbsolute, join, resolve } from 'node:path'
import type { PiPackageEntry } from '@shared/models'
import { readJsonFile } from './json-config'
import { discoverResources, EMPTY_RESOURCES } from './package-resources'
import { piAgentDir } from './pi-paths'

/**
 * Reading the `packages` arrays of pi's settings files and resolving each
 * entry to its install directory on disk.
 *
 * This module only reads state. Installs, removals and updates go through pi's
 * own CLI, which owns pinning, git-ref reconciliation and `npmCommand`
 * wrappers, so Phosphor never re-implements install semantics.
 */

/** A settings `packages` entry: plain spec or the filtered object form. */
type RawPackageEntry = string | { source: string; [key: string]: unknown }

interface ScopeDirs {
  /** Directory holding settings.json — relative path specs resolve here. */
  settingsDir: string
  scope: 'global' | 'project'
}

export function classifySpec(spec: string): 'npm' | 'git' | 'path' {
  if (spec.startsWith('npm:')) return 'npm'
  if (spec.startsWith('git:')) return 'git'
  if (/^(https?|ssh|git):\/\//.test(spec)) return 'git'
  return 'path'
}

/** `npm:@scope/name@1.2.3` → `@scope/name` (version suffix stripped). */
export function npmNameFromSpec(spec: string): string {
  const withoutPrefix = spec.slice('npm:'.length)
  const at = withoutPrefix.lastIndexOf('@')
  return at > 0 ? withoutPrefix.slice(0, at) : withoutPrefix
}

/**
 * Best-effort `<host>/<path>` for a git spec, mirroring pi's clone layout
 * (`<base>/git/<host>/<path>`). Handles `git:host/path`, `git@host:path`,
 * and protocol URLs; strips `.git` and `@ref` suffixes.
 */
export function gitDirFromSpec(spec: string): string | null {
  let rest = spec.startsWith('git:') ? spec.slice(4) : spec
  const protocol = /^(https?|ssh|git):\/\//.exec(rest)
  if (protocol) rest = rest.slice(protocol[0].length)
  // git@github.com:user/repo → github.com/user/repo
  const scpLike = /^[\w.-]+@([\w.-]+):(.+)$/.exec(rest)
  if (scpLike) rest = `${scpLike[1]}/${scpLike[2]}`
  // ssh://git@github.com/user/repo → github.com/user/repo
  else rest = rest.replace(/^[\w.-]+@/, '')
  // Strip a pinned ref, then .git
  const at = rest.lastIndexOf('@')
  if (at > rest.indexOf('/')) rest = rest.slice(0, at)
  if (rest.endsWith('.git')) rest = rest.slice(0, -4)
  return rest.includes('/') ? rest : null
}

export function resolveInstallPath(
  spec: string,
  kind: 'npm' | 'git' | 'path',
  dirs: ScopeDirs,
): string | null {
  // Global packages install beside `~/.pi/agent`; project packages under
  // `<ws>/.pi` — both are exactly the settings file's directory.
  const base = dirs.settingsDir
  if (kind === 'npm') return join(base, 'npm', 'node_modules', npmNameFromSpec(spec))
  if (kind === 'git') {
    const dir = gitDirFromSpec(spec)
    return dir ? join(base, 'git', dir) : null
  }
  return isAbsolute(spec) ? spec : resolve(base, spec)
}

async function readPackagesArray(settingsPath: string): Promise<RawPackageEntry[]> {
  // A missing or malformed file both read as empty here: malformed settings
  // are surfaced by pi:checkAgentSettings, so this module simply has nothing
  // to list.
  const { value } = await readJsonFile<{ packages?: unknown }>(settingsPath)
  if (!Array.isArray(value.packages)) return []
  return value.packages.filter(
    (entry): entry is RawPackageEntry =>
      typeof entry === 'string' ||
      (typeof entry === 'object' &&
        entry !== null &&
        typeof (entry as { source?: unknown }).source === 'string'),
  )
}

interface PackageJsonBits {
  name?: string
  version?: string
  description?: string
  pi?: unknown
}

function readPackageJson(dir: string): PackageJsonBits | null {
  try {
    return JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8')) as PackageJsonBits
  } catch {
    return null
  }
}

function toEntry(raw: RawPackageEntry, dirs: ScopeDirs): PiPackageEntry {
  const spec = typeof raw === 'string' ? raw : raw.source
  const filtered = typeof raw !== 'string'
  const kind = classifySpec(spec)
  const installPath = resolveInstallPath(spec, kind, dirs)
  const installed = installPath !== null && existsSync(installPath)

  const pkg = installed && installPath ? readPackageJson(installPath) : null
  const fallbackName =
    kind === 'npm'
      ? npmNameFromSpec(spec)
      : kind === 'git'
        ? (gitDirFromSpec(spec) ?? spec)
        : basename(spec)

  return {
    spec,
    scope: dirs.scope,
    kind,
    filtered,
    name: pkg?.name ?? fallbackName,
    version: pkg?.version,
    description: pkg?.description,
    installed,
    installPath: installPath ?? undefined,
    resources: installed && installPath ? discoverResources(installPath) : EMPTY_RESOURCES,
  }
}

/** All packages declared in the global and (when given) project settings. */
export async function listPackages(
  workspacePath?: string,
  agentDir = piAgentDir(),
): Promise<PiPackageEntry[]> {
  const scopes: ScopeDirs[] = [{ settingsDir: agentDir, scope: 'global' }]
  if (workspacePath) scopes.push({ settingsDir: join(workspacePath, '.pi'), scope: 'project' })

  const perScope = await Promise.all(
    scopes.map(async (dirs) => {
      const raws = await readPackagesArray(join(dirs.settingsDir, 'settings.json'))
      return raws.map((raw) => toEntry(raw, dirs))
    }),
  )
  return perScope.flat()
}
