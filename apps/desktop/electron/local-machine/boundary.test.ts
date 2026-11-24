import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

/**
 * The mode guard's boundary. In daemon mode This Mac's service runs every
 * lane, so no Desktop main module may reach the in-app spawn or write paths
 * except through a module that calls `assertInAppRuntime`:
 *
 * - print mode and the session writer, by the import graph below;
 * - `spawnSession` and `desktopSessions`, whose only spawn is
 *   `registry.create`, by pinning who builds a registry or a pi process.
 *
 * The Brain run is the one allowlisted exception (plan N8): ephemeral,
 * `--no-session`, through `@phosphor/brain-runtime/model-call`.
 */

const ROOT = resolve(import.meta.dirname, '../../../..')
const ELECTRON = 'apps/desktop/electron'
const ALIASES: Record<string, string> = {
  '@phosphor/shared': 'libs/shared/src',
  '@shared': 'libs/shared/src',
  '@phosphor/session-runtime': 'libs/session-runtime/src',
  '@phosphor/host-client': 'libs/host-client/src',
  '@phosphor/brain-runtime': 'libs/brain-runtime/src',
  '@phosphor/memory-engine': 'libs/memory-engine/src',
}

/** What daemon mode must never reach: `pi -p` runs and transcript byte writes. */
const TARGETS = [
  'libs/session-runtime/src/pi/print-mode.ts',
  'libs/session-runtime/src/pi/session-writer.ts',
]

/** Each calls `assertInAppRuntime` before it spawns or writes. */
const GUARDS = [
  `${ELECTRON}/pi/print-mode.ts`,
  `${ELECTRON}/pi/session-mutation.ts`,
  `${ELECTRON}/pi/session-title.ts`,
  `${ELECTRON}/pi/mcp-inspection.ts`,
]

/** Reaches print mode on purpose; the reason is the review record. */
const ALLOWED: Record<string, string> = {
  [`${ELECTRON}/brain/runtime.ts`]: "N8: Brain's ephemeral --no-session model runs",
}

function resolveImport(from: string, spec: string): string | null {
  let base: string
  if (spec.startsWith('.')) base = resolve(dirname(join(ROOT, from)), spec)
  else {
    const alias = Object.keys(ALIASES).find((a) => spec === a || spec.startsWith(`${a}/`))
    if (!alias) return null
    base = join(ROOT, ALIASES[alias]!, spec.slice(alias.length))
  }
  base = base.replace(/\.js$/, '')
  for (const candidate of [`${base}.ts`, `${base}.tsx`, join(base, 'index.ts'), base])
    if (existsSync(candidate) && statSync(candidate).isFile()) return relative(ROOT, candidate)
  return null
}

const IMPORT =
  /(?:^|\n)\s*(?:import|export)\s+(type\s+)?(?:[^'";]*?\sfrom\s+)?['"]([^'"]+)['"]|import\(\s*['"]([^'"]+)['"]\s*\)/g

const edges = new Map<string, string[]>()
/** Value imports only: `import type` and `export type` load nothing at runtime. */
function importsOf(file: string): string[] {
  const known = edges.get(file)
  if (known) return known
  const text = readFileSync(join(ROOT, file), 'utf8')
  const out: string[] = []
  for (const m of text.matchAll(IMPORT)) {
    if (m[1]) continue
    const target = resolveImport(file, (m[2] ?? m[3])!)
    if (target) out.push(target)
  }
  edges.set(file, out)
  return out
}

function sources(dir: string): string[] {
  return readdirSync(join(ROOT, dir)).flatMap((name) => {
    const path = `${dir}/${name}`
    if (statSync(join(ROOT, path)).isDirectory())
      return name === '__fixtures__' ? [] : sources(path)
    return /\.tsx?$/.test(name) && !/\.(test|d)\.tsx?$/.test(name) ? [path] : []
  })
}

/** The first import chain from `file` to a target that passes no guard, or null. */
function unguardedPath(file: string, stops: ReadonlySet<string>): string[] | null {
  const seen = new Set<string>()
  const walk = (at: string, path: string[]): string[] | null => {
    if (TARGETS.includes(at)) return path
    if (seen.has(at) || (at !== file && stops.has(at))) return null
    seen.add(at)
    for (const next of importsOf(at)) {
      const found = walk(next, [...path, next])
      if (found) return found
    }
    return null
  }
  return walk(file, [file])
}

const desktop = sources(ELECTRON)
const stops = new Set([...GUARDS, ...Object.keys(ALLOWED)])

describe('daemon-mode boundary', () => {
  it('reaches print mode and the session writer only through the mode guard', () => {
    const leaks = desktop
      .filter((file) => !stops.has(file))
      .map((file) => unguardedPath(file, stops))
      .filter((path): path is string[] => path !== null)
      .map((path) => path.join(' -> '))
    expect(leaks).toEqual([])
  })

  it('lists only guards and exceptions that still reach a target, and every guard calls it', () => {
    for (const file of [...GUARDS, ...Object.keys(ALLOWED)])
      expect(unguardedPath(file, new Set()), file).not.toBeNull()
    for (const file of GUARDS)
      expect(readFileSync(join(ROOT, file), 'utf8'), file).toMatch(/\bassertInAppRuntime\(/)
  })

  it('builds the session registry and pi processes only where the guard or a listed probe is', () => {
    const builders = desktop.filter((file) =>
      /\bnew (?:Core)?(?:SessionRegistry|PiRpcClient)\(|\bextends (?:Core)?SessionRegistry\b/.test(
        readFileSync(join(ROOT, file), 'utf8'),
      ),
    )
    expect(builders.sort()).toEqual([
      // `--no-session` probes; in daemon mode they belong to `machine.commands` and `machine.models` (M5).
      `${ELECTRON}/pi/commands.ts`,
      `${ELECTRON}/pi/model-catalogue.ts`,
      // The one Desktop registry class, instantiated only by the guarded `registry.ts`.
      `${ELECTRON}/pi/session-registry.ts`,
      `${ELECTRON}/registry.ts`,
    ])
    const registry = readFileSync(join(ROOT, ELECTRON, 'registry.ts'), 'utf8')
    expect(registry).toMatch(/\bassertInAppRuntime\(/)
    expect(registry.match(/\bnew \w+\(/g)).toEqual(['new InAppSessionRegistry('])
  })
})
