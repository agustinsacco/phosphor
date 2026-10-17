import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const root = resolve(import.meta.dirname, '../../..')
const homes = [
  {
    directory: 'libs/shared',
    source: 'src',
    existing: ['src/package-boundary.test.ts', 'src/host-protocol-testing/conformance.ts'],
    extraRoots: [],
  },
  {
    directory: 'libs/pi-extensions',
    source: 'pi-ext',
    existing: ['pi-ext/context-budget.test.ts', 'pi-ext/optional/permission-gate.test.ts'],
    extraRoots: [],
  },
  {
    directory: 'libs/session-runtime',
    source: 'src',
    existing: ['src/pi/boundary.test.ts', 'src/pi/session-path-lock.ts'],
    extraRoots: [],
  },
  {
    directory: 'apps/host',
    source: 'src',
    existing: ['src/commands/setup.test.ts', 'scripts/output.test.ts'],
    extraRoots: ['scripts'],
  },
  {
    directory: 'apps/control',
    source: 'src',
    existing: ['src/main.ts', 'scripts/build.test.ts'],
    extraRoots: ['scripts'],
  },
]

function parseConfig(path: string) {
  const config = ts.getParsedCommandLineOfConfigFile(
    path,
    {},
    {
      ...ts.sys,
      onUnRecoverableConfigFileDiagnostic(diagnostic) {
        throw new Error(ts.flattenDiagnosticMessageText(diagnostic.messageText, '\n'))
      },
    },
  )
  if (!config) throw new Error(`Could not parse ${path}`)
  expect(config.errors).toEqual([])
  return config
}

function write(path: string, contents: string) {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
}

describe.each(homes)('$directory/tsconfig.json', (home) => {
  const configPath = resolve(root, home.directory, 'tsconfig.json')

  it('owns existing tests and helpers with strict noEmit options', () => {
    const config = parseConfig(configPath)
    expect(config.options.strict).toBe(true)
    expect(config.options.noEmit).toBe(true)
    expect(config.options.target).toBe(ts.ScriptTarget.ES2023)
    expect(config.options.types).toContain('node')
    for (const path of home.existing)
      expect(config.fileNames).toContain(resolve(root, home.directory, path))
  })

  it('checks bad contracts in both test layouts and their unimported helpers', () => {
    const fixture = mkdtempSync(join(tmpdir(), 'phosphor-library-types-'))
    try {
      // Mirror the real config tree so inherited paths and include patterns are unchanged.
      write(
        join(fixture, 'tsconfig.base.json'),
        readFileSync(join(root, 'tsconfig.base.json'), 'utf8'),
      )
      symlinkSync(join(root, 'node_modules'), join(fixture, 'node_modules'), 'dir')
      const directory = join(fixture, home.directory)
      write(join(directory, 'tsconfig.json'), readFileSync(configPath, 'utf8'))
      const roots = [home.source, 'test', ...home.extraRoots]
      const paths = roots.flatMap((path) => [
        `${path}/nested/contract.test.ts`,
        `${path}/nested/helper.ts`,
      ])
      const contract = JSON.stringify(join(root, 'libs/shared/src/rpc.ts'))
      for (const path of paths)
        write(
          join(directory, path),
          `import type { ThinkingLevel } from ${contract}\nexport const invalid: ThinkingLevel = 'not-a-level'\n`,
        )
      write(join(directory, 'outside/ignored.ts'), 'export const invalid: number = "wrong"')
      const config = parseConfig(join(directory, 'tsconfig.json'))
      expect(config.fileNames.map((path) => relative(directory, path)).sort()).toEqual(paths.sort())
      const program = ts.createProgram(config.fileNames, config.options)
      expect(program.getOptionsDiagnostics()).toEqual([])
      expect(program.getSyntacticDiagnostics()).toEqual([])
      const errors = program.getSemanticDiagnostics()
      expect(errors).toHaveLength(paths.length)
      for (const path of paths)
        expect(
          errors.filter((error) => error.file?.fileName === join(directory, path)),
          path,
        ).toEqual([
          expect.objectContaining({
            code: 2322,
            messageText: expect.stringContaining('not-a-level'),
          }),
        ])
    } finally {
      rmSync(fixture, { recursive: true, force: true })
    }
  })
})
