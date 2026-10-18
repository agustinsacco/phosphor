import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'

// The site links into this repository by path. Moving a file (the Nx relocation
// moved scripts/install.sh) silently turns those links into GitHub 404s.
const root = resolve(import.meta.dirname, '../..')
const source = join(root, 'apps/site/src')
const files = readdirSync(source, { recursive: true, encoding: 'utf8' })
  .filter((file) => /\.(astro|ts)$/.test(file))
  .map((file) => readFileSync(join(source, file), 'utf8'))

it('every repository path the site links to exists', () => {
  const paths = new Set<string>()
  for (const text of files) {
    for (const [, path] of text.matchAll(/\$\{repo\}\/(?:blob|tree)\/main\/([^`"'#?\s]+)/g)) {
      if (path === undefined) throw new Error('Missing repository link path')
      if (!path.includes('${')) paths.add(path)
    }
    for (const [, path] of text.matchAll(/\bdoc\(['"]([^'"#]+)/g)) {
      if (path === undefined) throw new Error('Missing documentation link path')
      paths.add(`docs/${path}`)
    }
  }
  expect(paths.size).toBeGreaterThan(5)
  for (const path of paths) expect(existsSync(join(root, path)), path).toBe(true)
})
