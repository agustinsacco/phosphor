import { execFileSync } from 'node:child_process'
import { readFileSync, readdirSync } from 'node:fs'
import { isBuiltin } from 'node:module'
import { join, relative, resolve } from 'node:path'
import { build, type Plugin } from 'esbuild'
import ts from 'typescript'
import { describe, expect, it } from 'vitest'

const library = resolve(import.meta.dirname, '..')
const root = resolve(library, '../..')
const manifest = JSON.parse(readFileSync(join(library, 'package.json'), 'utf8'))
const excludedDirectories = new Set(['__fixtures__', '__tests__', 'test', 'tests'])
const forbiddenImport =
  /^(?:electron(?:-store|-updater)?(?:\/|$)|node-pty(?:\/|$)|@\/|@phosphor\/client-ui(?:\/|$))|(?:^|\/)apps\//

function productionSources(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = join(directory, entry.name)
    if (entry.isDirectory())
      return excludedDirectories.has(entry.name) ? [] : productionSources(file)
    return /\.[cm]?[jt]sx?$/.test(file) && !/\.(test|spec)\.[cm]?[jt]sx?$/.test(file) ? [file] : []
  })
}

function violations(file: string, text: string): string[] {
  const errors = ts
    .preProcessFile(text, true, true)
    .importedFiles.filter(({ fileName }) => forbiddenImport.test(fileName))
    .map(({ fileName }) => `forbidden import: ${fileName}`)
  const tree = ts.createSourceFile(file, text, ts.ScriptTarget.Latest, true)
  function visit(node: ts.Node): void {
    if (
      (ts.isPropertyAccessExpression(node) || ts.isElementAccessExpression(node)) &&
      ts.isIdentifier(node.expression) &&
      node.expression.text === 'process' &&
      (ts.isPropertyAccessExpression(node)
        ? node.name.text === 'parentPort'
        : node.argumentExpression &&
          ts.isStringLiteralLike(node.argumentExpression) &&
          node.argumentExpression.text === 'parentPort')
    )
      errors.push('Electron process.parentPort')
    ts.forEachChild(node, visit)
  }
  visit(tree)
  return errors
}

const portableBrain: Plugin = {
  name: 'portable-brain',
  setup(builder) {
    builder.onResolve({ filter: /.*/ }, ({ path }) => {
      if (forbiddenImport.test(path)) throw new Error(`Brain runtime forbidden import: ${path}`)
    })
    builder.onLoad({ filter: /\.[cm]?[jt]sx?$/ }, ({ path }) => {
      const local = relative(root, path).replaceAll('\\', '/')
      if (
        /^apps\/|^libs\/client-ui\/|(?:^|\/)(?:__fixtures__|__tests__|test|tests)\/|\.(?:test|spec)\./.test(
          local,
        )
      )
        throw new Error(`Brain runtime forbidden production input: ${local}`)
      const errors = violations(path, readFileSync(path, 'utf8'))
      if (errors.length) throw new Error(`Brain runtime ${errors.join(', ')}`)
    })
  },
}

// Importing the bundle must not start services. Guard dangerous effects before
// evaluation; this child never receives credentials, models or private paths.
const importGuard = `
(() => {
const { Module } = require('node:module');
const originalLoad = Module._load;
Module._load = function(name, ...args) {
  if (['node:sqlite', 'sqlite', 'electron', '@huggingface/transformers'].includes(name))
    throw new Error('Unexpected runtime load: ' + name);
  return originalLoad.call(this, name, ...args);
};
const refuse = () => { throw new Error('Unexpected import-time side effect'); };
for (const name of ['node:fs', 'node:fs/promises']) {
  const fs = require(name);
  for (const key of Object.keys(fs))
    if (/^(?:read|write|append|open|mkdir|mkdtemp|rm|unlink|rename|copy|watch|createRead|createWrite)/.test(key))
      if (typeof fs[key] === 'function') fs[key] = refuse;
}
for (const name of ['node:child_process', 'node:net', 'node:http', 'node:https', 'node:tls']) {
  const port = require(name);
  for (const key of ['spawn', 'spawnSync', 'exec', 'execFile', 'execSync', 'execFileSync', 'fork',
    'connect', 'createConnection', 'createServer', 'request', 'get'])
    if (key in port) port[key] = refuse;
}
globalThis.fetch = refuse;
})();
`

describe('Brain runtime source package boundary', () => {
  it('exports the entire production inventory as explicit source subpaths, never a barrel', () => {
    const files = productionSources(join(library, 'src'))
      .map((file) => relative(library, file).replaceAll('\\', '/'))
      .sort()
    expect(files.length).toBeGreaterThan(0)
    expect(manifest).toMatchObject({
      name: '@phosphor/brain-runtime',
      private: true,
      type: 'module',
    })
    expect(manifest.main).toBeUndefined()
    expect(manifest.exports).toEqual(
      Object.fromEntries(
        files.map((file) => [
          `./${file.slice(4).replace(/\.[cm]?[jt]sx?$/, '')}`,
          { types: `./${file}`, default: `./${file}` },
        ]),
      ),
    )
    expect(manifest.exports['.']).toBeUndefined()
    expect(Object.keys(manifest.exports)).not.toContain('./index')
    for (const file of files)
      expect(violations(file, readFileSync(join(library, file), 'utf8'))).toEqual([])
  })

  it('bundles and imports every entry under plain Node without starting services', async () => {
    const result = await build({
      absWorkingDir: root,
      stdin: {
        contents: Object.keys(manifest.exports)
          .map(
            (subpath, index) =>
              `export * as entry${index} from '${manifest.name}/${subpath.slice(2)}'`,
          )
          .join('\n'),
        resolveDir: root,
        loader: 'ts',
      },
      bundle: true,
      platform: 'node',
      format: 'cjs',
      write: false,
      metafile: true,
      tsconfig: join(library, 'tsconfig.json'),
      plugins: [portableBrain],
    })
    for (const input of Object.keys(result.metafile.inputs).filter((file) => file !== '<stdin>')) {
      expect(input).not.toMatch(/(?:^|\/)apps\/|(?:^|\/)electron\/|\.(?:test|spec)\./)
    }
    for (const output of Object.values(result.metafile.outputs)) {
      expect(output.imports.filter((entry) => entry.external && !isBuiltin(entry.path))).toEqual([])
    }
    const output = result.outputFiles[0]!
    const marker = 'Brain runtime imported without side effects'
    expect(
      execFileSync(process.execPath, ['--input-type=commonjs'], {
        cwd: root,
        input: importGuard + output.text + `\nconsole.log('${marker}')`,
        encoding: 'utf8',
        timeout: 10_000,
        env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
      }).trim(),
    ).toBe(marker)
  })

  it('refuses import-time database, subprocess and download effects in the smoke guard', () => {
    const run = (text: string) =>
      execFileSync(process.execPath, ['--input-type=commonjs'], {
        input: importGuard + text,
        encoding: 'utf8',
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout: 10_000,
        env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR },
      })
    expect(run("console.log('guard ready')").trim()).toBe('guard ready')
    for (const text of [
      "require('node:sqlite')",
      "require('node:child_process').spawn('pi')",
      "require('node:fs').openSync('memory.sqlite', 'w')",
      "fetch('https://example.invalid/model')",
    ])
      expect(() => run(text)).toThrow(/Unexpected/)
  })

  it.each([
    "import type { X } from 'electron'",
    "export { X } from '../../../apps/desktop/electron/brain/service'",
    "const load = () => import('electron')",
    "const electron = require('electron')",
    'process.parentPort.postMessage({})',
    "process['parentPort'].postMessage({})",
  ])('rejects the forbidden source fixture %s', (text) => {
    expect(violations('fixture.ts', text).length).toBeGreaterThan(0)
  })

  it.each(['electron', './apps/desktop/electron/store', './libs/client-ui/src/lib/format'])(
    'rejects forbidden graph fixture %s',
    async (path) => {
      await expect(
        build({
          absWorkingDir: root,
          stdin: { contents: `import ${JSON.stringify(path)}`, resolveDir: root, loader: 'ts' },
          bundle: true,
          platform: 'node',
          write: false,
          plugins: [portableBrain],
          logLevel: 'silent',
        }),
      ).rejects.toThrow(/Brain runtime forbidden/)
    },
  )
})
