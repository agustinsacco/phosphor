import type * as NodeChildProcess from 'node:child_process'
import { createHash } from 'node:crypto'
import type * as NodeFs from 'node:fs'
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { createRequire } from 'node:module'
import { tmpdir } from 'node:os'
import { dirname, join, resolve, sep } from 'node:path'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import { buildNative, PTY_VERSION } from './build-native.mjs'

// Characterizes buildNative through its public entry. Only the child processes
// (bundled-Node probe, node-gyp rebuild, smoke child), the runner target and,
// for one refusal, the node-pty manifest read are substituted. The node-pty
// source is Desktop's real installation, and the test proves it is untouched.
const state = vi.hoisted(() => ({
  target: undefined as string | undefined,
  ptyVersion: undefined as string | undefined,
}))
const exec = vi.hoisted(() =>
  vi.fn<(file: string, args: readonly string[], options?: { cwd?: string }) => string>(),
)
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeChildProcess>()),
  execFileSync: exec,
}))
vi.mock('node:process', async (importOriginal) => {
  const actual = await importOriginal<{ default: NodeJS.Process }>()
  const forcedRunner = new Proxy(actual.default, {
    get: (real, key) => {
      const [platform, arch] = state.target?.split('-') ?? []
      if (key === 'platform' && platform) return platform
      if (key === 'arch' && arch) return arch
      return Reflect.get(real, key)
    },
  })
  return { ...actual, default: forcedRunner }
})
vi.mock('node:fs', async (importOriginal) => {
  const actual = await importOriginal<typeof NodeFs>()
  const read = ((path: Parameters<typeof actual.readFileSync>[0], ...rest: unknown[]) =>
    state.ptyVersion && String(path).endsWith(join('node-pty', 'package.json'))
      ? JSON.stringify({ name: 'node-pty', version: state.ptyVersion })
      : Reflect.apply(actual.readFileSync, actual, [path, ...rest])) as typeof actual.readFileSync
  return { ...actual, readFileSync: read }
})

const root = resolve(import.meta.dirname, '../..')
const dir = realpathSync(mkdtempSync(join(tmpdir(), 'host-native-characterization-')))
const source = dirname(
  createRequire(import.meta.url).resolve('node-pty/package.json', {
    paths: [join(root, 'apps/desktop')],
  }),
)
const node = '/bundled/bin/node'
const probe = [
  '-p',
  'JSON.stringify({version:process.versions.node,target:process.platform+"-"+process.arch})',
]
const smoke = (out: string) => [
  '-e',
  `const p=require(${JSON.stringify(join(out, 'lib/index.js'))}); const t=p.spawn('/bin/sh',['-c','printf native-ok'],{cols:80,rows:24,cwd:'/tmp',env:{PATH:'/usr/bin:/bin'}}); let output='';t.onData(d=>output+=d); t.resize(81,25);t.onExit(e=>{if(e.exitCode!==0||!output.includes('native-ok'))process.exitCode=1});setTimeout(()=>process.exit(1),5000).unref()`,
]
const rebuild = [
  'exec',
  '--yes',
  '--package=node-gyp@11.4.2',
  '--',
  'node-gyp',
  'rebuild',
  '--target=24.14.1',
]
const sha = (path: string) => createHash('sha256').update(readFileSync(path)).digest('hex')
const tree = (folder: string) =>
  readdirSync(folder, { recursive: true })
    .map(String)
    .map((entry) => entry.split(sep).join('/'))
    .sort()
// Desktop's installation, including its Electron-rebuilt build tree, must survive every run.
const fingerprint = () => [
  readdirSync(source, { recursive: true }).length,
  ...[
    'package.json',
    'LICENSE',
    'build/Release/pty.node',
    'build/Release/spawn-helper',
    'prebuilds/darwin-arm64/pty.node',
    'prebuilds/darwin-arm64/spawn-helper',
  ].map((file) => {
    const path = join(source, file)
    return existsSync(path) ? `${file} ${statSync(path).mode} ${sha(path)}` : `${file} absent`
  }),
]
const sourceBefore = fingerprint()
let temps = ''
let out = ''
let count = 0

type Seen = { file: string; args: readonly string[]; options?: { cwd?: string } }
type Children = {
  runtime?: { version: string; target: string }
  rebuild?: (cwd: string) => void
  smoke?: () => void
}
const seen: Seen[] = []
function answerChildren({ runtime, rebuild: compile, smoke: child }: Children) {
  exec.mockImplementation((file, args, options) => {
    seen.push({ file, args, options })
    if (args[0] === '-p') return JSON.stringify(runtime)
    if (file !== 'npm') child?.()
    else if (compile) compile(String(options?.cwd))
    else throw new Error('unexpected rebuild')
    return ''
  })
}
function force(target: string) {
  state.target = target
  return { version: '24.14.1', target }
}

beforeEach(() => {
  count += 1
  temps = join(dir, `tmp-${count}`)
  out = join(dir, `out-${count}`)
  mkdirSync(temps)
  vi.stubEnv('TMPDIR', temps)
})
afterEach(() => {
  vi.unstubAllEnvs()
  state.target = undefined
  state.ptyVersion = undefined
  exec.mockReset()
  seen.length = 0
  expect(fingerprint()).toEqual(sourceBefore)
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

it('refuses an unsupported runner before probing Node or touching disk', () => {
  force('darwin-x64')
  expect(() => buildNative(out, node)).toThrow('Unsupported native target')
  expect(seen).toEqual([])
  expect(existsSync(out)).toBe(false)
  expect(readdirSync(temps)).toEqual([])
})

it('refuses a bundled Node whose version or target is not the pin before mutation', () => {
  for (const runtime of [
    { version: '24.14.0', target: 'darwin-arm64' },
    { version: '24.14.1', target: 'linux-arm64' },
  ]) {
    force('darwin-arm64')
    answerChildren({ runtime })
    expect(() => buildNative(out, node)).toThrow('Wrong native verification runtime')
  }
  expect(seen).toEqual([
    { file: node, args: probe, options: { encoding: 'utf8' } },
    { file: node, args: probe, options: { encoding: 'utf8' } },
  ])
  expect(existsSync(out)).toBe(false)
  expect(readdirSync(temps)).toEqual([])
})

it('refuses an existing output and leaves it in place', () => {
  answerChildren({ runtime: force('darwin-arm64') })
  mkdirSync(out)
  writeFileSync(join(out, 'keep'), 'owned by someone else')
  expect(() => buildNative(out, node)).toThrow('Native output already exists')
  expect(readFileSync(join(out, 'keep'), 'utf8')).toBe('owned by someone else')
  expect(seen).toHaveLength(1)
  expect(readdirSync(temps)).toEqual([])
})

it('refuses a node-pty source that is not the pinned version before mutation', () => {
  answerChildren({ runtime: force('darwin-arm64') })
  state.ptyVersion = '1.0.0'
  expect(() => buildNative(out, node)).toThrow('Wrong node-pty version')
  expect(seen).toHaveLength(1)
  expect(existsSync(out)).toBe(false)
  expect(readdirSync(temps)).toEqual([])
})

it('stages the shipped prebuild, never the Desktop build tree, and smokes it with bundled Node', () => {
  const desktopBuild = join(source, 'build/Release/pty.node')
  const prebuild = join(source, 'prebuilds/darwin-arm64')
  // Desktop's install always carries an Electron-rebuilt addon that differs from the prebuild.
  expect(existsSync(desktopBuild)).toBe(true)
  expect(sha(desktopBuild)).not.toBe(sha(join(prebuild, 'pty.node')))
  let staged: string[] = []
  answerChildren({ runtime: force('darwin-arm64'), smoke: () => (staged = tree(out)) })
  buildNative(out, node)
  const shipped = readdirSync(join(source, 'lib'))
    .filter((name) => name.endsWith('.js') && !name.endsWith('.test.js'))
    .map((name) => `lib/${name}`)
  expect(tree(out)).toEqual(
    [
      'LICENSE',
      'TARGET.json',
      'build',
      'build/Release',
      'build/Release/pty.node',
      'build/Release/spawn-helper',
      'lib',
      ...shipped,
    ].sort(),
  )
  expect(staged).toEqual(tree(out))
  expect(shipped).toContain('lib/index.js')
  expect(sha(join(out, 'build/Release/pty.node'))).toBe(sha(join(prebuild, 'pty.node')))
  expect(sha(join(out, 'build/Release/spawn-helper'))).toBe(sha(join(prebuild, 'spawn-helper')))
  expect(statSync(join(out, 'build/Release/spawn-helper')).mode & 0o777).toBe(0o755)
  expect(sha(join(out, 'LICENSE'))).toBe(sha(join(source, 'LICENSE')))
  expect(readFileSync(join(out, 'TARGET.json'), 'utf8')).toBe(
    `{"target":"darwin-arm64","node":"24.14.1","version":"${PTY_VERSION}"}\n`,
  )
  expect(seen).toEqual([
    { file: node, args: probe, options: { encoding: 'utf8' } },
    { file: node, args: smoke(out), options: { stdio: 'pipe' } },
  ])
  expect(readdirSync(temps)).toEqual([])
}, 30000)

it('clean-rebuilds a temporary copy for a target without a prebuild', () => {
  const at: { cwd?: string; build?: boolean; addon?: boolean } = {}
  answerChildren({
    runtime: force('linux-x64'),
    rebuild: (cwd) => {
      Object.assign(at, {
        cwd,
        build: existsSync(join(cwd, 'build')),
        addon: existsSync(join(cwd, '../node_modules/node-addon-api/package.json')),
      })
      mkdirSync(join(cwd, 'build/Release'), { recursive: true })
      writeFileSync(join(cwd, 'build/Release/pty.node'), 'clean rebuild')
    },
  })
  buildNative(out, node)
  expect(dirname(dirname(String(at.cwd)))).toBe(temps)
  expect(at.cwd).toMatch(/\/host-native-[^/]+\/node-pty$/)
  expect(at.build).toBe(false)
  expect(at.addon).toBe(true)
  expect(readFileSync(join(out, 'build/Release/pty.node'), 'utf8')).toBe('clean rebuild')
  expect(existsSync(join(out, 'build/Release/spawn-helper'))).toBe(false)
  expect(readFileSync(join(out, 'TARGET.json'), 'utf8')).toBe(
    `{"target":"linux-x64","node":"24.14.1","version":"${PTY_VERSION}"}\n`,
  )
  expect(seen).toEqual([
    { file: node, args: probe, options: { encoding: 'utf8' } },
    { file: 'npm', args: rebuild, options: { cwd: at.cwd, stdio: 'pipe' } },
    { file: node, args: smoke(out), options: { stdio: 'pipe' } },
  ])
  expect(readdirSync(temps)).toEqual([])
}, 30000)

it('deletes the staged output and the temporary copy when the smoke child fails', () => {
  const failure = new Error('smoke failed')
  let staged = false
  answerChildren({
    runtime: force('darwin-arm64'),
    smoke: () => {
      staged = existsSync(join(out, 'TARGET.json')) && readdirSync(temps).length === 1
      throw failure
    },
  })
  expect(() => buildNative(out, node)).toThrow(failure)
  expect(staged).toBe(true)
  expect(existsSync(out)).toBe(false)
  expect(readdirSync(temps)).toEqual([])
}, 30000)

it('deletes the temporary copy and leaves no output when the clean rebuild fails', () => {
  answerChildren({
    runtime: force('linux-arm64'),
    rebuild: () => {
      throw new Error('node-gyp failed')
    },
  })
  expect(() => buildNative(out, node)).toThrow('node-gyp failed')
  expect(seen.map(({ file }) => file)).toEqual([node, 'npm'])
  expect(existsSync(out)).toBe(false)
  expect(readdirSync(temps)).toEqual([])
}, 30000)
