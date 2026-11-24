import { readFileSync, readdirSync } from 'node:fs'
import { resolve } from 'node:path'
import { expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '..')
const features: Record<string, string[]> = {
  sessions: ['sessions', 'home', 'workspaces', 'worktrees', 'archive'],
  chat: ['chat'],
  rest: ['settings', 'skills', 'routines', 'connectors', 'files', 'terminal', 'artifacts'],
}
function sources(dir: string): string[] {
  return readdirSync(resolve(root, dir), { withFileTypes: true }).flatMap((entry) => {
    const path = `${dir}/${entry.name}`
    if (entry.isDirectory()) return entry.name === '__fixtures__' ? [] : sources(path)
    return /\.tsx?$/.test(path) && !/\.(?:spec|test)\.tsx?$/.test(path) ? [path] : []
  })
}
const ledgers = readdirSync(resolve(root, 'platform/branch-ledger')).filter((f) =>
  f.endsWith('.json'),
)
it('always ships the sessions ledger', () => expect(ledgers).toContain('sessions.json'))
it.each(ledgers)('keeps every audited branch count in %s current', (file) => {
  const ledger: Record<string, { protocol: number; 'same-machine': number }> = JSON.parse(
    readFileSync(resolve(root, 'platform/branch-ledger', file), 'utf8'),
  )
  const dirs = features[file.replace('.json', '')]!
  const paths = new Set([
    ...dirs.flatMap((dir) => sources(`features/${dir}`)),
    ...Object.keys(ledger),
  ])
  for (const path of paths) {
    const source = readFileSync(resolve(root, path), 'utf8')
    const count = [
      ...source.matchAll(
        /\bkind\s*(?:===|!==)\s*(['"])remote\1|\bstartsWith\(\s*(['"])host:\2\s*\)/g,
      ),
    ].length
    const entry = ledger[path]
    if (entry) {
      expect(Object.keys(entry).sort(), path).toEqual(['protocol', 'same-machine'])
      for (const n of Object.values(entry)) expect(Number.isInteger(n) && n >= 0, path).toBe(true)
    }
    expect(count, path).toBe(entry ? entry.protocol + entry['same-machine'] : 0)
  }
})
