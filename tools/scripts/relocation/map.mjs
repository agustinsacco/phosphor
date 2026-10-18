import { realpathSync, existsSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { repoPath } from '../select-unit-tests.mjs'

// First matching row wins. Existing test trees and excluded surfaces are identities.
export const MAPPING_ROWS = [
  ['apps/desktop/electron/', 'apps/desktop/test/main/'],
  ['apps/desktop/src/', 'apps/desktop/test/renderer/'],
  ['apps/desktop/scripts/', 'apps/desktop/test/scripts/'],
  ['apps/host/src/', 'apps/host/test/'],
  ['apps/host/scripts/', 'apps/host/test/scripts/'],
  ['apps/control/src/', 'apps/control/test/'],
  ['apps/control/scripts/', 'apps/control/test/scripts/'],
  ['libs/shared/src/', 'libs/shared/test/'],
  ['libs/session-runtime/src/', 'libs/session-runtime/test/'],
  ['libs/pi-extensions/pi-ext/', 'libs/pi-extensions/test/'],
  ['tools/scripts/', 'tools/scripts/test/'],
  ['tools/host-release/', 'tools/host-release/test/'],
]
export const SHIPPING_FIXTURE =
  'apps/desktop/src/features/chat/__fixtures__/real-session-events.jsonl'
export const SHIPPING_DESTINATION = 'apps/desktop/src/dev/fixtures/real-session-events.jsonl'

export function relocationTarget(file) {
  repoPath(file)
  if (file === SHIPPING_FIXTURE) return SHIPPING_DESTINATION
  if (/^(?:apps\/[^/]+|libs\/[^/]+|tools\/(?:scripts|host-release))\/test\//.test(file)) return file
  const row = MAPPING_ROWS.find(([from]) => file.startsWith(from))
  if (row) {
    const [from, to] = row
    return (
      to +
      file
        .slice(from.length)
        .split('/')
        .filter((part) => part !== '__tests__')
        .join('/')
    )
  }
  if (/^apps\/desktop\/[^/]+\.test\.tsx?$/.test(file))
    return file.replace('apps/desktop/', 'apps/desktop/test/')
  return file
}

export function findCollisions(files, moves) {
  const sources = new Set(moves.map(({ from }) => repoPath(from)))
  const destinations = new Map()
  const collisions = []
  for (const file of files) {
    repoPath(file)
    if (!sources.has(file)) destinations.set(file.toLowerCase(), file)
  }
  for (const { from, to } of moves) {
    repoPath(to)
    const existing = destinations.get(to.toLowerCase())
    if (existing) collisions.push({ from, to, existing })
    destinations.set(to.toLowerCase(), to)
  }
  return collisions
}

// Check both endpoints, including existing destination parents; never follow an escape.
export function assertContained(root, file) {
  repoPath(file)
  const base = realpathSync(root)
  let path = resolve(root, file)
  while (!existsSync(path)) path = dirname(path)
  const suffix = relative(base, realpathSync(path))
  if (suffix === '..' || suffix.startsWith('../') || suffix.startsWith('..\\'))
    throw new Error(`Symlink escape: ${file}`)
}
