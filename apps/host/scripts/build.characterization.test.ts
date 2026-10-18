// Characterizes the Host build CLI, apps/host/scripts/build.mjs, as it runs
// today. One build runs from the repository itself. The rest run copies of
// the build scripts from scratch fixture roots, whose stand-in Host source and
// resources reach the stamp, boundary, resource and refusal paths without
// touching the checkout. Every build writes only into scratch folders.
import { execFileSync, spawnSync, type SpawnSyncReturns } from 'node:child_process'
import { createHash } from 'node:crypto'
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { isBuiltin } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, relative, resolve } from 'node:path'
import { BUNDLED_EXTENSION_FILES } from '@phosphor/session-runtime/bundled-extensions'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

const SCRIPTS = import.meta.dirname
const REPO = resolve(SCRIPTS, '../../..')
const SHA = 'b'.repeat(40)
const BANNER =
  "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);"
const NODE_PIN: string = JSON.parse(
  readFileSync(join(REPO, 'tools/host-release/node.json'), 'utf8'),
).version
const HOST_TARGET = `${process.platform}-${process.arch}`
const MANIFEST_KEYS = [
  'schema',
  'name',
  'version',
  'sourceSha',
  'sourceDirty',
  'nodeTarget',
  'entry',
  'files',
]
/** A Host that prints the stamps it was built with and whether the banner's require exists. */
const STAMPS_MAIN = `declare const __PHOSPHOR_HOST_SOURCE_SHA__: string | undefined
declare const __PHOSPHOR_HOST_RELEASE_VERSION__: string | undefined
import { helper } from './helper'
console.log(
  JSON.stringify({
    sha: typeof __PHOSPHOR_HOST_SOURCE_SHA__ === 'string' ? __PHOSPHOR_HOST_SOURCE_SHA__ : null,
    release:
      typeof __PHOSPHOR_HOST_RELEASE_VERSION__ === 'string'
        ? __PHOSPHOR_HOST_RELEASE_VERSION__
        : null,
    require: typeof require,
    helper: helper(),
  }),
)
`
/** Every file a fixture root's build writes, in BUILD-INFO.json's order. */
const FIXTURE_FILES = [
  'phosphor.mjs',
  'phosphor.mjs.map',
  'pi-ext/Upper.ts',
  'pi-ext/artifacts.ts',
  'pi-ext/context-breakdown.ts',
  'pi-ext/headroom.ts',
  'pi-ext/helper-store.ts',
  'pi-ext/lane-reload.ts',
  'pi-ext/nested/deep.ts',
  'pi-ext/tool-name-guard.ts',
  'pi-ext/types.d.ts',
  'pi-ext/worktree-paths.ts',
  'skills/visual-artifacts/SKILL.md',
  'skills/visual-artifacts/check.test.ts',
  'skills/visual-artifacts/references/mermaid.md',
]
const FIXTURE_FOLDERS = [
  'pi-ext',
  'pi-ext/nested',
  'pi-ext/tests-only',
  'skills',
  'skills/visual-artifacts',
  'skills/visual-artifacts/references',
]
const NATIVE_FILES = [
  'native/node-pty/LICENSE',
  'native/node-pty/TARGET.json',
  'native/node-pty/build/Release/pty.node',
  'native/node-pty/build/Release/spawn-helper',
  'native/node-pty/lib/index.js',
]

let scratch: string
beforeAll(() => {
  scratch = mkdtempSync(join(realpathSync(tmpdir()), 'phosphor-build-cli-'))
})
afterAll(() => rmSync(scratch, { recursive: true, force: true }))

/** The test's environment without git or release overrides, so neither leaks into a build. */
function cleanEnv(): NodeJS.ProcessEnv {
  return Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !key.startsWith('GIT_') && key !== 'HOST_RELEASE_VERSION',
    ),
  )
}

/** Runs build.mjs under `root`, from the scratch folder, finding no git repository above `root`. */
function build(
  root: string,
  args: string[],
  env: Record<string, string> = {},
): SpawnSyncReturns<string> {
  return spawnSync(process.execPath, [join(root, 'apps/host/scripts/build.mjs'), ...args], {
    cwd: scratch,
    encoding: 'utf8',
    env: { ...cleanEnv(), GIT_CEILING_DIRECTORIES: scratch, ...env },
  })
}

function write(root: string, path: string, text: string) {
  mkdirSync(dirname(join(root, path)), { recursive: true })
  writeFileSync(join(root, path), text)
}

/** A scratch repository root: copies of the build scripts, `main` as the Host, stand-in resources. */
function fixtureRoot(main = STAMPS_MAIN): string {
  const root = mkdtempSync(join(scratch, 'root-'))
  mkdirSync(join(root, 'apps/host/scripts'), { recursive: true })
  for (const file of readdirSync(SCRIPTS).filter((name) => name.endsWith('.mjs'))) {
    cpSync(join(SCRIPTS, file), join(root, 'apps/host/scripts', file))
  }
  write(root, 'apps/host/src/main.ts', main)
  write(root, 'apps/host/src/helper.ts', "export const helper = () => 'helped'\n")
  symlinkSync(join(REPO, 'tools'), join(root, 'tools'))
  mkdirSync(join(root, 'node_modules'))
  symlinkSync(join(REPO, 'node_modules/esbuild'), join(root, 'node_modules/esbuild'))
  symlinkSync(join(REPO, 'node_modules/@phosphor'), join(root, 'node_modules/@phosphor'))
  const ext = 'libs/pi-extensions/pi-ext'
  for (const file of BUNDLED_EXTENSION_FILES)
    write(root, `${ext}/${file}`, `export default '${file}'\n`)
  write(root, `${ext}/helper-store.ts`, 'export const store = 1\n')
  write(root, `${ext}/Upper.ts`, 'export const upper = 1\n')
  write(root, `${ext}/types.d.ts`, 'export type Kind = string\n')
  write(root, `${ext}/nested/deep.ts`, 'export const deep = 1\n')
  write(root, `${ext}/nested/deep.test.ts`, 'test\n')
  write(root, `${ext}/headroom.test.ts`, 'test\n')
  write(root, `${ext}/tests-only/only.test.ts`, 'test\n')
  write(root, `${ext}/README.md`, 'readme\n')
  write(root, `${ext}/legacy.js`, 'legacy\n')
  const skill = 'libs/pi-extensions/skills/visual-artifacts'
  write(root, `${skill}/SKILL.md`, '# Skill\n')
  write(root, `${skill}/references/mermaid.md`, '# Mermaid\n')
  write(root, `${skill}/check.test.ts`, 'skills are copied whole\n')
  return root
}

/** A fresh output path whose parent folder holds nothing else. */
function freshOut(): string {
  return join(mkdtempSync(join(scratch, 'out-')), 'dist')
}

/** Every entry under `dir`, folders included, sorted. */
function tree(dir: string): string[] {
  return readdirSync(dir, { recursive: true, encoding: 'utf8' }).sort()
}

const sha256 = (bytes: Buffer) => createHash('sha256').update(bytes).digest('hex')

/** BUILD-INFO.json, checked to be exactly every other file in `out`, sorted, with size and sha256. */
function manifest(out: string) {
  const text = readFileSync(join(out, 'BUILD-INFO.json'), 'utf8')
  const info = JSON.parse(text)
  expect(text).toBe(`${JSON.stringify(info, null, 2)}\n`)
  expect(Object.keys(info)).toEqual(MANIFEST_KEYS)
  const onDisk = tree(out).filter(
    (path) => path !== 'BUILD-INFO.json' && statSync(join(out, path)).isFile(),
  )
  expect(info.files).toEqual(
    onDisk.map((path) => {
      const bytes = readFileSync(join(out, path))
      return { path, bytes: bytes.length, sha256: sha256(bytes) }
    }),
  )
  for (const file of info.files) expect(Object.keys(file)).toEqual(['path', 'bytes', 'sha256'])
  return info
}

/** What the built stand-in Host prints. */
function stamps(out: string) {
  const ran = spawnSync(process.execPath, [join(out, 'phosphor.mjs')], { encoding: 'utf8' })
  expect(ran.status, ran.stderr).toBe(0)
  return JSON.parse(ran.stdout)
}

/** The build failed with `message`, its last line, and left no output and no staging folder. */
function expectFailed(result: SpawnSyncReturns<string>, out: string, message: string) {
  expect(result.status).toBe(1)
  expect(result.stdout).toBe('')
  expect(result.stderr.trimEnd().split('\n').at(-1)).toBe(`build: ${message}`)
  expect(existsSync(out)).toBe(false)
  expect(readdirSync(dirname(out))).toEqual([])
}

const gitConfig = [
  '-c',
  'user.name=Phosphor',
  '-c',
  'user.email=build@phosphor.invalid',
  '-c',
  'commit.gpgsign=false',
  '-c',
  'core.hooksPath=/dev/null',
]
function git(root: string, ...args: string[]): string {
  return execFileSync('git', [...gitConfig, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: cleanEnv(),
  }).trim()
}

/** Makes `root` a git repository with everything but node_modules committed; returns HEAD. */
function commitAll(root: string): string {
  writeFileSync(join(root, '.gitignore'), 'node_modules/\n')
  git(root, 'init', '-q')
  git(root, 'add', '-A')
  git(root, 'commit', '-q', '--no-verify', '-m', 'fixture')
  return git(root, 'rev-parse', 'HEAD')
}

/** A node-pty folder validateNative accepts for `target`, without the files in `omit`. */
function nativeFolder(target = HOST_TARGET, omit: string[] = []): string {
  const native = mkdtempSync(join(scratch, 'native-'))
  const files: Record<string, string> = {
    'TARGET.json': JSON.stringify({ target, node: NODE_PIN, version: '1.1.0' }),
    'lib/index.js': 'module.exports = {}\n',
    'build/Release/pty.node': 'addon',
    'build/Release/spawn-helper': 'helper',
    LICENSE: 'MIT\n',
  }
  for (const [path, text] of Object.entries(files)) {
    if (!omit.includes(path)) write(native, path, text)
  }
  return native
}

/** `folder`, with `path` in it replaced by an empty folder of that name. */
function asFolder(folder: string, path: string): string {
  rmSync(join(folder, path))
  mkdirSync(join(folder, path))
  return folder
}

describe('build.mjs from the repository', { timeout: 120_000 }, () => {
  let out: string
  let result: SpawnSyncReturns<string>
  beforeAll(() => {
    out = freshOut()
    result = build(REPO, ['--out', out, '--sha', SHA])
  })

  it('stamps a dev build with --sha, a linked source map and the tree state', () => {
    expect(result.status, result.stderr).toBe(0)
    const info = manifest(out)
    expect(info).toMatchObject({
      schema: 1,
      name: 'phosphor',
      version: '0.0.0-dev.bbbbbbb',
      sourceSha: SHA,
      nodeTarget: 'node22',
      entry: 'phosphor.mjs',
    })
    expect(typeof info.sourceDirty).toBe('boolean')
    expect(result.stdout).toMatch(
      new RegExp(
        `^${relative(scratch, out)}: 0\\.0\\.0-dev\\.bbbbbbb, ${info.files.length} files, [1-9]\\d* inputs\\n$`,
      ),
    )
    const source = readFileSync(join(out, 'phosphor.mjs'), 'utf8')
    expect(source.startsWith(`${BANNER}\n`)).toBe(true)
    expect(source.trimEnd().split('\n').at(-1)).toBe('//# sourceMappingURL=phosphor.mjs.map')
    expect(existsSync(join(out, 'phosphor.mjs.map'))).toBe(true)
  })

  it('imports nothing but Node builtins and reaches no Electron or Desktop module', () => {
    const source = readFileSync(join(out, 'phosphor.mjs'), 'utf8')
    const specifiers = [
      ...source.matchAll(/^\s*(?:import|export)\b[^'"\n]*?from\s*["']([^"']+)["']/gm),
      ...source.matchAll(/^\s*import\s*["']([^"']+)["']/gm),
      ...source.matchAll(/\b(?:import|require)\(\s*["']([^"']+)["']\s*\)/g),
    ].map((match) => match[1]!)
    expect(specifiers.length).toBeGreaterThan(5)
    expect(specifiers.filter((specifier) => !isBuiltin(specifier))).toEqual([])
    expect(source).not.toMatch(/electron|apps\/desktop/)
  })

  it("copies the library's pi-ext with Desktop's filter and its skills whole", () => {
    const pi = join(REPO, 'libs/pi-extensions/pi-ext')
    const kept = tree(pi).filter(
      (path) =>
        statSync(join(pi, path)).isDirectory() ||
        (path.endsWith('.ts') && !path.endsWith('.test.ts')),
    )
    expect(tree(join(out, 'pi-ext'))).toEqual(kept)
    for (const file of BUNDLED_EXTENSION_FILES) expect(kept).toContain(file)
    const skills = join(REPO, 'libs/pi-extensions/skills')
    expect(tree(join(out, 'skills'))).toEqual(tree(skills))
    for (const [from, to] of [
      [pi, 'pi-ext'],
      [skills, 'skills'],
    ] as const) {
      for (const path of tree(join(out, to)).filter((p) => statSync(join(from, p)).isFile())) {
        expect(readFileSync(join(out, to, path)).equals(readFileSync(join(from, path))), path).toBe(
          true,
        )
      }
    }
  })
})

describe('build.mjs stamps', { timeout: 120_000 }, () => {
  it('defaults the output to apps/host/dist under its root and prints where it went', () => {
    const root = fixtureRoot()
    const result = build(root, ['--sha', SHA])
    expect(result.status, result.stderr).toBe(0)
    const out = join(root, 'apps/host/dist')
    const info = manifest(out)
    expect(result.stdout).toBe(
      `${relative(scratch, out)}: 0.0.0-dev.bbbbbbb, ${FIXTURE_FILES.length} files, 2 inputs\n`,
    )
    expect(result.stderr).toBe('')
    expect(info.files.map((file: { path: string }) => file.path)).toEqual(FIXTURE_FILES)
    expect(tree(out)).toEqual(['BUILD-INFO.json', ...FIXTURE_FILES, ...FIXTURE_FOLDERS].sort())
  })

  it("stamps a dev build with HEAD's commit and a clean tree, and links its source map", () => {
    const root = fixtureRoot()
    const head = commitAll(root)
    const out = freshOut()
    const result = build(root, ['--out', out])
    expect(result.status, result.stderr).toBe(0)
    expect(manifest(out)).toMatchObject({
      version: `0.0.0-dev.${head.slice(0, 7)}`,
      sourceSha: head,
      sourceDirty: false,
      nodeTarget: 'node22',
      entry: 'phosphor.mjs',
    })
    expect(stamps(out)).toEqual({ sha: head, release: null, require: 'function', helper: 'helped' })
    const source = readFileSync(join(out, 'phosphor.mjs'), 'utf8')
    expect(source.startsWith(`${BANNER}\n`)).toBe(true)
    expect(source.trimEnd().split('\n').at(-1)).toBe('//# sourceMappingURL=phosphor.mjs.map')
    const map = JSON.parse(readFileSync(join(out, 'phosphor.mjs.map'), 'utf8'))
    expect(map.sources.map((path: string) => resolve(out, path)).sort()).toEqual([
      join(root, 'apps/host/src/helper.ts'),
      join(root, 'apps/host/src/main.ts'),
    ])
  })

  it('marks a dev build dirty for an untracked file, a release build only for a tracked change', () => {
    const root = fixtureRoot()
    const head = commitAll(root)
    const dirty = (env: Record<string, string> = {}) => {
      const out = freshOut()
      const result = build(root, ['--out', out], env)
      expect(result.status, result.stderr).toBe(0)
      const info = manifest(out)
      expect(info.sourceSha).toBe(head)
      return info.sourceDirty
    }
    writeFileSync(join(root, 'untracked.txt'), 'new\n')
    expect(dirty()).toBe(true)
    expect(dirty({ HOST_RELEASE_VERSION: '1.2.3' })).toBe(false)
    writeFileSync(join(root, 'apps/host/src/helper.ts'), "export const helper = () => 'changed'\n")
    expect(dirty({ HOST_RELEASE_VERSION: '1.2.3' })).toBe(true)
    rmSync(join(root, 'untracked.txt'))
    git(root, 'checkout', '--', 'apps/host/src/helper.ts')
    expect(dirty()).toBe(false)
  })

  it('stamps a release build with HOST_RELEASE_VERSION and leaves out the source map', () => {
    const root = fixtureRoot()
    const out = freshOut()
    const result = build(root, ['--out', out, '--sha', SHA], { HOST_RELEASE_VERSION: '1.2.3' })
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toBe(
      `${relative(scratch, out)}: 1.2.3, ${FIXTURE_FILES.length - 1} files, 2 inputs\n`,
    )
    const info = manifest(out)
    // No git repository here: the failed status reads as a dirty tree.
    expect(info).toMatchObject({ version: '1.2.3', sourceSha: SHA, sourceDirty: true })
    expect(info.files.map((file: { path: string }) => file.path)).toEqual(
      FIXTURE_FILES.filter((path) => path !== 'phosphor.mjs.map'),
    )
    expect(stamps(out)).toEqual({
      sha: SHA,
      release: '1.2.3',
      require: 'function',
      helper: 'helped',
    })
    const source = readFileSync(join(out, 'phosphor.mjs'), 'utf8')
    expect(source).not.toContain('sourceMappingURL')
    expect(source.startsWith(`${BANNER}\n`)).toBe(true)
  })

  it.each(['0.0.0', '123456789.987654321.0'])('accepts the release version %s', (version) => {
    const out = freshOut()
    const result = build(fixtureRoot(), ['--out', out, '--sha', SHA], {
      HOST_RELEASE_VERSION: version,
    })
    expect(result.status, result.stderr).toBe(0)
    expect(manifest(out).version).toBe(version)
  })

  it.each([
    ['a sha that is not 40 hex digits', ['--sha', 'not-a-sha'], {}],
    ['an upper-case sha', ['--sha', 'B'.repeat(40)], {}],
    ['a 39-digit sha', ['--sha', 'b'.repeat(39)], {}],
    ['no sha and no git repository', [], {}],
    ['a release with no usable sha', ['--sha', 'nope'], { HOST_RELEASE_VERSION: '2.0.0' }],
  ])('leaves a build unstamped for %s', (_, args, env: Record<string, string>) => {
    const out = freshOut()
    const result = build(fixtureRoot(), ['--out', out, ...args], env)
    expect(result.status, result.stderr).toBe(0)
    const version = env.HOST_RELEASE_VERSION ?? '0.0.0-dev.source'
    expect(manifest(out)).toMatchObject({ version, sourceSha: null, sourceDirty: null })
    expect(stamps(out)).toMatchObject({ sha: null, release: env.HOST_RELEASE_VERSION ?? null })
  })

  it.each([
    '',
    '1.2',
    '1.2.3.4',
    'v1.2.3',
    '01.2.3',
    '1.02.3',
    '1.2.03',
    '1.2.3-rc.1',
    '1234567890.0.0',
    ' 1.2.3',
  ])('refuses the release version %j before building anything', (version) => {
    const out = freshOut()
    const result = build(fixtureRoot(), ['--out', out, '--sha', SHA], {
      HOST_RELEASE_VERSION: version,
    })
    expect(result.status).toBe(1)
    expect([result.stdout, result.stderr]).toEqual(['', 'build: invalid HOST_RELEASE_VERSION\n'])
    expect(readdirSync(dirname(out))).toEqual([])
  })

  it('refuses an option it does not know', () => {
    const out = freshOut()
    const result = build(fixtureRoot(), ['--out', out, '--bogus'])
    expect(result.status).toBe(1)
    expect(result.stderr).toContain("Unknown option '--bogus'")
    expect(readdirSync(dirname(out))).toEqual([])
  })
})

describe('build.mjs boundary', { timeout: 120_000 }, () => {
  it.each(['electron', 'electron/main', 'electron-store', 'electron-updater/out/main', 'node-pty'])(
    'refuses a Host that imports %s',
    (specifier) => {
      const root = fixtureRoot(`import '${specifier}'\n`)
      const out = freshOut()
      const message = `the Host reached ${specifier} from ${root}/apps/host/src/main.ts`
      expectFailed(build(root, ['--out', out, '--sha', SHA]), out, message)
    },
  )

  it('reports one refusal when the Host imports two forbidden modules', () => {
    const root = fixtureRoot("import 'electron'\nimport 'node-pty'\n")
    const out = freshOut()
    const result = build(root, ['--out', out, '--sha', SHA])
    expect(result.status).toBe(1)
    expect(result.stderr.trimEnd().split('\n').at(-1)).toMatch(
      new RegExp(
        `^build: the Host reached (electron|node-pty) from ${root}/apps/host/src/main\\.ts$`,
      ),
    )
    expect(readdirSync(dirname(out))).toEqual([])
  })

  it.each([
    ['node_modules/electron/index.js', '../../../node_modules/electron/index.js'],
    ['node_modules/node-pty/lib/index.js', '../../../node_modules/node-pty/lib/index.js'],
    [
      'libs/vendor/node_modules/electron-store/index.js',
      '../../../libs/vendor/node_modules/electron-store/index.js',
    ],
    ['apps/desktop/leak.ts', '../../desktop/leak'],
    ['apps/site/leak.ts', '../../site/leak'],
  ])('refuses a Host that bundles %s by a path', (input, specifier) => {
    const root = fixtureRoot(`import '${specifier}'\n`)
    write(root, input, "console.log('leak')\n")
    const out = freshOut()
    expectFailed(build(root, ['--out', out, '--sha', SHA]), out, `the Host bundled ${input}`)
  })

  it('refuses a bundle that imports anything but a Node builtin, naming each once', () => {
    const root = fixtureRoot(
      "import a from 'https://example.com/a.js'\nimport c from 'https://example.com/c.js'\nimport { readFileSync } from 'node:fs'\nconsole.log(a, c, readFileSync, await import('https://example.com/a.js'))\n",
    )
    const out = freshOut()
    expectFailed(
      build(root, ['--out', out, '--sha', SHA]),
      out,
      'the bundle imports https://example.com/a.js, https://example.com/c.js, which are not Node builtins',
    )
  })

  it("stubs ws's optional native helpers with a module that throws", () => {
    const root = fixtureRoot("import 'bufferutil'\nimport 'utf-8-validate'\n")
    const out = freshOut()
    const result = build(root, ['--out', out, '--sha', SHA])
    expect(result.status, result.stderr).toBe(0)
    expect(manifest(out).files.map((file: { path: string }) => file.path)).toEqual(FIXTURE_FILES)
    const ran = spawnSync(process.execPath, [join(out, 'phosphor.mjs')], { encoding: 'utf8' })
    expect(ran.status).toBe(1)
    expect(ran.stderr).toContain('Error: Optional native helper disabled')
  })
})

describe('build.mjs resources and output', { timeout: 120_000 }, () => {
  it.each([
    [['headroom.ts'], 'pi-ext lacks headroom.ts'],
    [['lane-reload.ts', 'artifacts.ts'], 'pi-ext lacks artifacts.ts, lane-reload.ts'],
  ])('refuses pi-ext without %j', (missing, message) => {
    const root = fixtureRoot()
    for (const file of missing) rmSync(join(root, 'libs/pi-extensions/pi-ext', file))
    const out = freshOut()
    expectFailed(build(root, ['--out', out, '--sha', SHA]), out, message)
  })

  it('copies a node-pty folder named relative to the working folder and lists it', () => {
    const native = nativeFolder()
    const out = freshOut()
    const result = build(fixtureRoot(), [
      '--out',
      out,
      '--sha',
      SHA,
      '--native',
      relative(scratch, native),
    ])
    expect(result.status, result.stderr).toBe(0)
    const paths = manifest(out).files.map((file: { path: string }) => file.path)
    expect(paths).toEqual([...NATIVE_FILES, ...FIXTURE_FILES])
    for (const path of NATIVE_FILES) {
      const source = join(native, path.slice('native/node-pty/'.length))
      expect(readFileSync(join(out, path), 'utf8')).toBe(readFileSync(source, 'utf8'))
    }
  })

  it('checks the node-pty folder against --target when it is given', () => {
    const native = nativeFolder('linux-x64', ['build/Release/spawn-helper'])
    const out = freshOut()
    const args = ['--out', out, '--sha', SHA, '--native', native, '--target', 'linux-x64']
    const result = build(fixtureRoot(), args)
    expect(result.status, result.stderr).toBe(0)
    expect(manifest(out).files.map((file: { path: string }) => file.path)).toEqual([
      ...NATIVE_FILES.filter((path) => !path.endsWith('spawn-helper')),
      ...FIXTURE_FILES,
    ])
  })

  it('ignores --target without --native', () => {
    const out = freshOut()
    const result = build(fixtureRoot(), ['--out', out, '--sha', SHA, '--target', 'bogus'])
    expect(result.status, result.stderr).toBe(0)
    expect(manifest(out).files.map((file: { path: string }) => file.path)).toEqual(FIXTURE_FILES)
  })

  it.each([
    [
      'a marker for another target',
      () => nativeFolder('other-target'),
      [],
      'Native target mismatch',
    ],
    [
      'a mismatched --target',
      () => nativeFolder(),
      ['--target', 'other-target'],
      'Native target mismatch',
    ],
    [
      'a LICENSE that is a folder',
      () => asFolder(nativeFolder(), 'LICENSE'),
      [],
      'Missing native resource',
    ],
    [
      'a macOS spawn helper that is a folder',
      () => asFolder(nativeFolder('darwin-arm64'), 'build/Release/spawn-helper'),
      ['--target', 'darwin-arm64'],
      'Missing spawn helper',
    ],
  ])('refuses a node-pty folder with %s', (_, native, args: string[], message) => {
    const out = freshOut()
    const result = build(fixtureRoot(), ['--out', out, '--sha', SHA, '--native', native(), ...args])
    expectFailed(result, out, message)
  })

  it('refuses a node-pty folder that lacks a file it checks, naming the file', () => {
    const native = nativeFolder(HOST_TARGET, ['LICENSE'])
    const out = freshOut()
    const result = build(fixtureRoot(), ['--out', out, '--sha', SHA, '--native', native])
    const message = `ENOENT: no such file or directory, lstat '${native}/LICENSE'`
    expectFailed(result, out, message)
  })

  it.each([
    [
      'a forbidden import before a missing extension',
      "import 'electron'\n",
      (root: string) => rmSync(join(root, 'libs/pi-extensions/pi-ext/headroom.ts')),
      [],
      /^the Host reached electron from /,
    ],
    [
      'a bundled Desktop file before a bad node-pty folder',
      "import '../../desktop/leak'\n",
      (root: string) => write(root, 'apps/desktop/leak.ts', "console.log('leak')\n"),
      ['--native', '__native__'],
      /^the Host bundled apps\/desktop\/leak\.ts$/,
    ],
    [
      'a bad node-pty folder before a missing extension',
      STAMPS_MAIN,
      (root: string) => rmSync(join(root, 'libs/pi-extensions/pi-ext/headroom.ts')),
      ['--native', '__native__'],
      /^Native target mismatch$/,
    ],
  ])('reports %s', (_, main, arrange, args: string[], message) => {
    const root = fixtureRoot(main)
    arrange(root)
    const native = nativeFolder('other-target')
    const out = freshOut()
    const all = [
      '--out',
      out,
      '--sha',
      SHA,
      ...args.map((arg) => (arg === '__native__' ? native : arg)),
    ]
    const result = build(root, all)
    expect(result.status).toBe(1)
    const last = result.stderr.trimEnd().split('\n').at(-1)!
    expect(last.slice('build: '.length)).toMatch(message)
    expect(readdirSync(dirname(out))).toEqual([])
  })

  it('refuses an invalid release version before a foreign output', () => {
    const out = freshOut()
    mkdirSync(out)
    writeFileSync(join(out, 'notes.txt'), 'keep')
    const result = build(fixtureRoot(), ['--out', out], { HOST_RELEASE_VERSION: 'x' })
    expect([result.status, result.stderr]).toEqual([1, 'build: invalid HOST_RELEASE_VERSION\n'])
    expect(tree(out)).toEqual(['notes.txt'])
  })

  it.each([
    [
      'holds a file of its own',
      (out: string) => writeFileSync(join(out, 'notes.txt'), 'keep'),
      'holds no BUILD-INFO.json file',
    ],
    [
      "holds another tool's manifest",
      (out: string) =>
        writeFileSync(
          join(out, 'BUILD-INFO.json'),
          JSON.stringify({ schema: 1, name: 'other', files: [] }),
        ),
      "holds a BUILD-INFO.json that is not this Host's",
    ],
  ])('refuses, before building, an output that %s', (_, arrange, refusal) => {
    const root = fixtureRoot("import 'electron'\n")
    const out = freshOut()
    mkdirSync(out)
    arrange(out)
    const before = tree(out).map((path) => [path, readFileSync(join(out, path), 'utf8')])
    const result = build(root, ['--out', out, '--sha', SHA])
    expect([result.status, result.stdout, result.stderr]).toEqual([
      1,
      '',
      `build: ${out} ${refusal}: refusing to replace it\n`,
    ])
    expect(tree(out).map((path) => [path, readFileSync(join(out, path), 'utf8')])).toEqual(before)
    expect(readdirSync(dirname(out))).toEqual(['dist'])
  })

  it('refuses an output that is a file', () => {
    const out = freshOut()
    writeFileSync(out, 'keep')
    const result = build(fixtureRoot(), ['--out', out, '--sha', SHA])
    expect([result.status, result.stderr]).toEqual([
      1,
      `build: ${out} is not a folder: refusing to replace it\n`,
    ])
    expect(readFileSync(out, 'utf8')).toBe('keep')
  })

  it('replaces its own earlier build and an empty folder, leaving nothing beside them', () => {
    const root = fixtureRoot()
    const out = freshOut()
    mkdirSync(out)
    expect(build(root, ['--out', out, '--sha', SHA]).status).toBe(0)
    const first = manifest(out)
    writeFileSync(join(root, 'apps/host/src/helper.ts'), "export const helper = () => 'again'\n")
    const again = build(root, ['--out', out, '--sha', SHA])
    expect(again.status, again.stderr).toBe(0)
    const second = manifest(out)
    expect(second.files.map((file: { path: string }) => file.path)).toEqual(FIXTURE_FILES)
    expect(second.files[0].sha256).not.toBe(first.files[0].sha256)
    expect(stamps(out).helper).toBe('again')
    expect(readdirSync(dirname(out))).toEqual(['dist'])
  })
})
