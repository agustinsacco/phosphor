import { readdirSync, readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { describe, expect, it } from 'vitest'

const src = import.meta.dirname
const root = resolve(src, '../../..')
const exported = (library: string) =>
  Object.keys(JSON.parse(readFileSync(join(root, library, 'package.json'), 'utf8')).exports)
const LIBRARIES: Record<string, string[]> = {
  '@phosphor/shared': exported('libs/shared'),
  '@phosphor/session-runtime': exported('libs/session-runtime'),
  // This subpath is a pure wire-literal module.
  '@phosphor/pi-extensions': ['./status-keys'],
}
const SPECIFIER = /(?:\bfrom\s+|\bimport\s*\(\s*)'([^']+)'/g

const files = readdirSync(src, { recursive: true, encoding: 'utf8' })
  .filter((file) => file.endsWith('.ts'))
  .map((file) => join(src, file))

function assertPackageImport(specifier: string | undefined, file: string, support: boolean) {
  if (specifier === 'ws') {
    if (!file.startsWith(join(src, 'api') + '/')) throw new Error('ws is only allowed in Host api/')
    return
  }
  expect(support && specifier === 'vitest', `${file}: ${specifier}`).toBe(true)
}

describe('Host import boundary', () => {
  it('refuses ws outside the API adapter', () => {
    expect(() => assertPackageImport('ws', join(src, 'commands/run.ts'), false)).toThrow(
      'ws is only allowed in Host api/',
    )
    expect(() => assertPackageImport('ws', join(src, 'api/server.ts'), false)).not.toThrow()
  })
  it('reaches the libraries only through exported subpaths, and nothing else outside Node', () => {
    expect(files.length).toBeGreaterThan(10)
    for (const file of files) {
      const support = file.endsWith('.test.ts') || file.includes('/__fixtures__/')
      for (const [, specifier] of readFileSync(file, 'utf8').matchAll(SPECIFIER)) {
        const where = `${file}: ${specifier}`
        if (specifier!.startsWith('node:')) continue
        if (specifier!.startsWith('.')) {
          const target = resolve(dirname(file), specifier!)
          expect(target.startsWith(src), where).toBe(true)
          if (!support) expect(target.includes('/__fixtures__/'), where).toBe(false)
          continue
        }
        const library = Object.keys(LIBRARIES).find((name) => specifier!.startsWith(`${name}/`))
        if (library) {
          expect(LIBRARIES[library], where).toContain(`./${specifier!.slice(library.length + 1)}`)
          continue
        }
        // A bundle carries Node builtins only; tests may use their runner.
        assertPackageImport(specifier, file, support)
      }
    }
  })
})
