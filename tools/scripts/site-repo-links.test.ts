import { existsSync, readFileSync, readdirSync } from 'node:fs'
import { join, resolve } from 'node:path'
import { expect, it } from 'vitest'
import { DOWNLOAD_ARTIFACTS, DOWNLOAD_PATH_PREFIX } from '@phosphor/shared/control-api'

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

// Download links go through the control server's counting redirect. A path it
// does not know falls through to the site's 404 instead of the release.
it('every download link names an artifact the redirect serves, and crawlers skip them', () => {
  const linked = new Set<string>()
  for (const text of files)
    for (const [, artifact] of text.matchAll(/[`"'}]\/download\/([^/`"'\s|<]*)/g))
      linked.add(artifact ?? '')
  expect([...linked].sort()).toEqual([...DOWNLOAD_ARTIFACTS].sort())
  const robots = readFileSync(join(root, 'apps/site/public/robots.txt'), 'utf8')
  expect(robots.split('\n')).toContain(`Disallow: ${DOWNLOAD_PATH_PREFIX}`)
})
