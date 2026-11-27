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
  // Brain's lane-scoped briefing and private socket client, not its engine or store.
  '@phosphor/brain-client': exported('libs/brain-client'),
  // The Host's own Brain (its engine, store and worker protocols) and the handover's copy,
  // digest and checks. The libraries' boundary tests keep them free of Electron.
  '@phosphor/brain-runtime': exported('libs/brain-runtime'),
  '@phosphor/memory-engine': exported('libs/memory-engine'),
  // Browser-safe: the reach pool speaks the Host protocol as a client.
  '@phosphor/host-client': exported('libs/host-client'),
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
  // Only the embedding worker's own process loads the model runtime, never the Host bundle.
  if (specifier === '@huggingface/transformers') {
    if (file !== join(src, 'brain/embedding-worker.ts'))
      throw new Error('@huggingface/transformers is only allowed in the Brain embedding worker')
    return
  }
  // The terminal screen is the one place that draws with Clack; commands stay plain.
  if (specifier === '@clack/prompts') {
    if (!file.startsWith(join(src, 'ui') + '/'))
      throw new Error('@clack/prompts is only allowed in Host ui/')
    return
  }
  // Tests may use their runner, and esbuild to bundle a module for a child
  // process (state-dir's umask case); neither reaches the Host bundle.
  expect(
    support && (specifier === 'vitest' || specifier === 'esbuild'),
    `${file}: ${specifier}`,
  ).toBe(true)
}

describe('Host import boundary', () => {
  it('refuses ws outside the API adapter', () => {
    expect(() => assertPackageImport('ws', join(src, 'commands/run.ts'), false)).toThrow(
      'ws is only allowed in Host api/',
    )
    expect(() => assertPackageImport('ws', join(src, 'api/server.ts'), false)).not.toThrow()
  })
  it('refuses the embedding model runtime outside its worker', () => {
    expect(() =>
      assertPackageImport('@huggingface/transformers', join(src, 'brain/runtime.ts'), false),
    ).toThrow('only allowed in the Brain embedding worker')
    expect(() =>
      assertPackageImport(
        '@huggingface/transformers',
        join(src, 'brain/embedding-worker.ts'),
        false,
      ),
    ).not.toThrow()
  })
  it('refuses Clack outside the terminal screen', () => {
    expect(() =>
      assertPackageImport('@clack/prompts', join(src, 'commands/doctor.ts'), false),
    ).toThrow('@clack/prompts is only allowed in Host ui/')
    expect(() =>
      assertPackageImport('@clack/prompts', join(src, 'ui/screen.ts'), false),
    ).not.toThrow()
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
          // Tests share library fixtures and can drive the shipped tool through the Host dispatcher.
          if (support && specifier!.includes('/__fixtures__/')) continue
          const subpath = `./${specifier!.slice(library.length + 1)}`
          const allowed =
            support && library === '@phosphor/pi-extensions'
              ? [...LIBRARIES[library]!, './phosphor']
              : LIBRARIES[library]
          expect(allowed, where).toContain(subpath)
          continue
        }
        // A bundle carries Node builtins only; tests may use their runner.
        assertPackageImport(specifier, file, support)
      }
    }
  })
})
