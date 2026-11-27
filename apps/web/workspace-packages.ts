import { readFileSync } from 'node:fs'
import { resolve } from 'node:path'
import type { Alias } from 'vite'

/** Public entries the browser bundle imports by workspace package name. */
const BROWSER_ENTRIES = {
  'client-ui': ['compact', 'bootstrap', 'styles/index.css'],
  'pi-extensions': ['subagent-snapshot', 'swarm', 'lane-reload'],
} as const

const exactly = (id: string) => new RegExp(`^${id.replace(/[.*+?^${}()|[\]\\/]/g, '\\$&')}$`)

/**
 * Resolves each listed entry to this checkout's manifest target, never through a linked
 * node_modules that may belong to another checkout, and refuses every other subpath.
 */
export function workspacePackageAliases(root: string): Alias[] {
  const entries = Object.entries(BROWSER_ENTRIES).flatMap(([pkg, subpaths]) => {
    const dir = resolve(root, 'libs', pkg)
    const { exports } = JSON.parse(readFileSync(resolve(dir, 'package.json'), 'utf8')) as {
      exports: Record<string, string | { default?: string } | undefined>
    }
    return subpaths.map((subpath) => {
      const target = exports[`./${subpath}`]
      const file = typeof target === 'string' ? target : target?.default
      if (!file) throw new Error(`@phosphor/${pkg} does not export ./${subpath}`)
      return { find: exactly(`@phosphor/${pkg}/${subpath}`), replacement: resolve(dir, file) }
    })
  })
  const unlisted: Alias = {
    find: new RegExp(`^@phosphor/(?:${Object.keys(BROWSER_ENTRIES).join('|')})(?:/.*)?$`),
    replacement: '$&',
    customResolver(source) {
      throw new Error(`${source} is not a listed browser entry of its workspace package`)
    },
  }
  return [...entries, unlisted]
}
