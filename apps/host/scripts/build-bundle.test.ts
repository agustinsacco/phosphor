import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { build, type Metafile, type Plugin } from 'esbuild'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import {
  auditMetafile,
  bundleHost,
  bundleOptions,
  FORBIDDEN,
  hostBoundary,
  NODE_TARGET,
  OUTFILE,
  wsPlainJs,
} from './build-bundle.mjs'

const SHA = 'c'.repeat(40)

let root: string
beforeEach(() => {
  root = mkdtempSync(join(realpathSync(tmpdir()), 'phosphor-build-bundle-'))
})
afterEach(() => rmSync(root, { recursive: true, force: true }))

function write(path: string, text: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}

/** A metafile with these inputs and one output importing `imports`. */
function metafile(inputs: string[], ...outputs: string[][]): Metafile {
  return {
    inputs: Object.fromEntries(inputs.map((path) => [path, { bytes: 1, imports: [] }])),
    outputs: Object.fromEntries(
      outputs.map((imports, i) => [
        `out-${i}.mjs`,
        {
          bytes: 1,
          inputs: {},
          exports: [],
          imports: imports.map((path) => ({ path, kind: 'import-statement', external: true })),
        },
      ]),
    ),
  } as Metafile
}

/** esbuild on `contents` with only `plugins`, in memory. */
function bundleSource(contents: string, plugins: Plugin[]) {
  return build({
    stdin: { contents, resolveDir: root, loader: 'ts' },
    bundle: true,
    write: false,
    format: 'esm',
    platform: 'node',
    logLevel: 'silent',
    plugins,
  })
}

describe('auditMetafile', () => {
  it('passes a bundle of allowed inputs that imports only Node builtins', () => {
    const inputs = [
      'apps/host/src/main.ts',
      'node_modules/ws/index.js',
      'node_modules/electronic/index.js',
      'node_modules/node-pty-shim/index.js',
      'apps/desktopish/a.ts',
      'libs/apps/desktop/a.ts',
    ]
    expect(() =>
      auditMetafile(metafile(inputs, ['fs', 'node:fs', 'node:child_process'])),
    ).not.toThrow()
  })

  it('names every forbidden input, in metafile order', () => {
    const inputs = [
      'apps/host/src/main.ts',
      'apps/site/src/a.ts',
      'node_modules/electron/index.js',
      'libs/x/node_modules/node-pty/lib/index.js',
      'node_modules/electron-updater/out/main.js',
      'node_modules/electron-store/index.js',
      'apps/desktop/electron/main.ts',
    ]
    expect(() => auditMetafile(metafile(inputs, []))).toThrow(
      new Error(
        'the Host bundled apps/site/src/a.ts, node_modules/electron/index.js, libs/x/node_modules/node-pty/lib/index.js, node_modules/electron-updater/out/main.js, node_modules/electron-store/index.js, apps/desktop/electron/main.ts',
      ),
    )
  })

  it('refuses a forbidden input before a foreign import', () => {
    const file = metafile(['apps/desktop/a.ts'], ['https://example.com/a.js'])
    expect(() => auditMetafile(file)).toThrow(new Error('the Host bundled apps/desktop/a.ts'))
  })

  it('names each import that is not a Node builtin once, across outputs', () => {
    const file = metafile(
      ['apps/host/src/main.ts'],
      ['node:fs', 'https://example.com/a.js', 'ws'],
      ['https://example.com/a.js', 'fs'],
    )
    expect(() => auditMetafile(file)).toThrow(
      new Error('the bundle imports https://example.com/a.js, ws, which are not Node builtins'),
    )
  })

  it('forbids exactly the Electron packages, node-pty, Desktop and the site', () => {
    expect(FORBIDDEN.map(String)).toEqual([
      String(/(^|\/)node_modules\/(electron|electron-store|electron-updater|node-pty)\//),
      String(/^apps\/(desktop|site)\//),
    ])
  })
})

describe('hostBoundary', () => {
  it.each(['electron', 'electron/main', 'electron-store', 'electron-updater/out', 'node-pty'])(
    'refuses %s and records the refusal',
    async (specifier) => {
      const boundary = hostBoundary()
      expect(boundary.reached()).toBeNull()
      await expect(bundleSource(`import '${specifier}'`, [boundary.plugin])).rejects.toThrow(
        `the Host reached ${specifier} from <stdin>`,
      )
      expect(boundary.reached()).toBe(`the Host reached ${specifier} from <stdin>`)
    },
  )

  it('repeats the first refusal for every later one', async () => {
    const boundary = hostBoundary()
    write('a.ts', "import 'node-pty'\n")
    const failing = bundleSource("import 'electron'\nimport './a'\n", [boundary.plugin])
    const error = await failing.catch((caught: { errors: { text: string }[] }) => caught)
    const texts = (error as { errors: { text: string }[] }).errors.map((entry) => entry.text)
    expect(texts.length).toBe(2)
    expect(new Set(texts)).toEqual(new Set([boundary.reached()]))
  })

  it('leaves alone a package that only starts with a forbidden name', async () => {
    const boundary = hostBoundary()
    write('node_modules/electronic/index.js', 'export const value = 1\n')
    write('node_modules/node-pty-shim/index.js', 'export const shim = 2\n')
    const result = await bundleSource(
      "import { value } from 'electronic'\nimport { shim } from 'node-pty-shim'\nconsole.log(value, shim)\n",
      [boundary.plugin],
    )
    expect(result.outputFiles[0]!.text).toContain('console.log(value, shim)')
    expect(boundary.reached()).toBeNull()
  })
})

describe('wsPlainJs', () => {
  it("replaces ws's optional native helpers with a module that throws", async () => {
    const result = await bundleSource("import 'bufferutil'\nimport 'utf-8-validate'\n", [wsPlainJs])
    const text = result.outputFiles[0]!.text
    expect(text.match(/throw new Error\("Optional native helper disabled"\)/g)).toHaveLength(2)
  })

  it('resolves anything else as usual', async () => {
    const failing = bundleSource("import 'bufferutil/extra'\n", [wsPlainJs])
    await expect(failing).rejects.toThrow('Could not resolve "bufferutil/extra"')
  })
})

describe('bundleOptions', () => {
  const plugins = [wsPlainJs]

  it('builds a dev bundle with a linked source map and the commit stamped', () => {
    const options = bundleOptions({
      root,
      stage: '/stage',
      stamped: SHA,
      releaseVersion: undefined,
      plugins,
    })
    expect(options).toMatchObject({
      absWorkingDir: root,
      entryPoints: ['apps/host/src/main.ts'],
      outfile: `/stage/${OUTFILE}`,
      bundle: true,
      platform: 'node',
      format: 'esm',
      target: NODE_TARGET,
      sourcemap: 'linked',
      metafile: true,
      logLevel: 'warning',
      tsconfigRaw: { compilerOptions: { paths: { '@shared/*': ['./libs/shared/src/*'] } } },
      banner: {
        js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);",
      },
      define: { __PHOSPHOR_HOST_SOURCE_SHA__: JSON.stringify(SHA) },
    })
    expect(options.plugins).toBe(plugins)
  })

  it('builds a release bundle with no source map and the release version stamped', () => {
    const options = bundleOptions({
      root,
      stage: '/s',
      stamped: SHA,
      releaseVersion: '1.2.3',
      plugins,
    })
    expect(options.sourcemap).toBe(false)
    expect(options.define).toEqual({
      __PHOSPHOR_HOST_SOURCE_SHA__: JSON.stringify(SHA),
      __PHOSPHOR_HOST_RELEASE_VERSION__: '"1.2.3"',
    })
  })

  it('stamps nothing for an unstamped dev build', () => {
    const options = bundleOptions({
      root,
      stage: '/s',
      stamped: null,
      releaseVersion: undefined,
      plugins,
    })
    expect([options.sourcemap, options.define]).toEqual(['linked', {}])
  })
})

describe('bundleHost', () => {
  it('bundles the Host from its root into the stage and returns what it read', async () => {
    write('apps/host/src/main.ts', "import { greet } from './greet'\nconsole.log(greet())\n")
    write(
      'apps/host/src/greet.ts',
      "import { EOL } from 'node:os'\nexport const greet = () => EOL\n",
    )
    const stage = join(root, 'stage')
    const inputs = await bundleHost(stage, { root, stamped: SHA, releaseVersion: undefined })
    expect(inputs.sort()).toEqual(['apps/host/src/greet.ts', 'apps/host/src/main.ts'])
    expect(readdirSync(stage).sort()).toEqual([OUTFILE, `${OUTFILE}.map`])
  })

  it('throws a boundary refusal alone, rather than the report of esbuild', async () => {
    write('apps/host/src/main.ts', "import 'electron'\n")
    const stage = join(root, 'stage')
    const failing = bundleHost(stage, { root, stamped: null, releaseVersion: '1.0.0' })
    await expect(failing).rejects.toThrow(
      new Error(`the Host reached electron from ${root}/apps/host/src/main.ts`),
    )
    expect(existsSync(join(stage, OUTFILE))).toBe(false)
  })

  it("rethrows esbuild's own failure when no boundary was reached", async () => {
    write('apps/host/src/main.ts', "import './missing'\n")
    const failing = bundleHost(join(root, 'stage'), {
      root,
      stamped: null,
      releaseVersion: undefined,
    })
    await expect(failing).rejects.toThrow(/Build failed with 1 error[\s\S]*Could not resolve/)
  })

  it('audits what it built', async () => {
    write('apps/host/src/main.ts', "import '../../desktop/leak'\n")
    write('apps/desktop/leak.ts', "console.log('leak')\n")
    const failing = bundleHost(join(root, 'stage'), {
      root,
      stamped: null,
      releaseVersion: '1.0.0',
    })
    await expect(failing).rejects.toThrow(new Error('the Host bundled apps/desktop/leak.ts'))
  })

  it('stamps the commit and release version into the bundle', async () => {
    write(
      'apps/host/src/main.ts',
      'declare const __PHOSPHOR_HOST_SOURCE_SHA__: string\ndeclare const __PHOSPHOR_HOST_RELEASE_VERSION__: string\nconsole.log(__PHOSPHOR_HOST_SOURCE_SHA__, __PHOSPHOR_HOST_RELEASE_VERSION__)\n',
    )
    const stage = join(root, 'stage')
    await bundleHost(stage, { root, stamped: SHA, releaseVersion: '1.2.3' })
    expect(readdirSync(stage)).toEqual([OUTFILE])
    expect(readFileSync(join(stage, OUTFILE), 'utf8')).toContain(`console.log("${SHA}", "1.2.3")`)
  })
})
