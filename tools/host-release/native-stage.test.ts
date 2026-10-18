import type * as NodeChildProcess from 'node:child_process'
import {
  chmodSync,
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
import { tmpdir } from 'node:os'
import { dirname, join, sep } from 'node:path'
import { afterAll, afterEach, beforeEach, expect, it, vi } from 'vitest'
import { validateNative } from './build-native.mjs'
import { prepareNativeSource, stageNativeResources } from './native-stage.mjs'

const exec = vi.hoisted(() =>
  vi.fn<(file: string, args: readonly string[], options?: { cwd?: string }) => string>(),
)
vi.mock('node:child_process', async (importOriginal) => ({
  ...(await importOriginal<typeof NodeChildProcess>()),
  execFileSync: exec,
}))

const dir = realpathSync(mkdtempSync(join(tmpdir(), 'host-native-stage-')))
let base = ''
let count = 0
const write = (path: string, contents: string, mode = 0o644) => {
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, contents)
  chmodSync(path, mode)
}
const tree = (folder: string) =>
  readdirSync(folder, { recursive: true })
    .map((entry) => String(entry).split(sep).join('/'))
    .sort()
/** A node-pty installation: Desktop's Electron build tree, a darwin-arm64 prebuild, its addon dependency. */
function fakeSource() {
  const source = join(base, 'source')
  write(join(source, 'package.json'), JSON.stringify({ name: 'node-pty', version: '1.1.0' }))
  write(join(source, 'LICENSE'), 'MIT')
  write(join(source, 'lib/index.js'), 'index')
  write(join(source, 'build/Release/pty.node'), 'electron addon')
  write(join(source, 'prebuilds/darwin-arm64/pty.node'), 'darwin prebuild')
  write(join(source, 'prebuilds/darwin-arm64/spawn-helper'), 'darwin helper')
  write(join(source, 'node_modules/node-addon-api/package.json'), '{"name":"node-addon-api"}')
  return source
}

beforeEach(() => {
  count += 1
  base = join(dir, `case-${count}`)
  mkdirSync(join(base, 'temp'), { recursive: true })
})
afterEach(() => exec.mockReset())
afterAll(() => rmSync(dir, { recursive: true, force: true }))

it('selects the shipped prebuild from a copy without the source build tree', () => {
  const source = fakeSource()
  const temp = join(base, 'temp')
  const prepared = prepareNativeSource({
    source,
    temp,
    target: 'darwin-arm64',
    nodeVersion: '24.14.1',
  })
  const packageRoot = join(temp, 'node-pty')
  expect(prepared).toEqual({ packageRoot, binary: join(packageRoot, 'prebuilds/darwin-arm64') })
  expect(exec).not.toHaveBeenCalled()
  expect(existsSync(join(packageRoot, 'build'))).toBe(false)
  expect(readFileSync(join(packageRoot, 'lib/index.js'), 'utf8')).toBe('index')
  expect(readFileSync(join(source, 'build/Release/pty.node'), 'utf8')).toBe('electron addon')
})

it('clean-rebuilds the copy with the pinned node-gyp when the target has no prebuild', () => {
  const source = fakeSource()
  const temp = join(base, 'temp')
  const packageRoot = join(temp, 'node-pty')
  const at: { build?: boolean; addon?: string } = {}
  exec.mockImplementation((_file, _args, options) => {
    const cwd = String(options?.cwd)
    at.build = existsSync(join(cwd, 'build'))
    at.addon = readFileSync(join(temp, 'node_modules/node-addon-api/package.json'), 'utf8')
    write(join(cwd, 'build/Release/pty.node'), 'node addon')
    return ''
  })
  const prepared = prepareNativeSource({ source, temp, target: 'linux-x64', nodeVersion: '24.9.9' })
  expect(prepared).toEqual({ packageRoot, binary: join(packageRoot, 'build/Release') })
  expect(exec.mock.calls).toEqual([
    [
      'npm',
      [
        'exec',
        '--yes',
        '--package=node-gyp@11.4.2',
        '--',
        'node-gyp',
        'rebuild',
        '--target=24.9.9',
      ],
      { cwd: packageRoot, stdio: 'pipe' },
    ],
  ])
  expect(at).toEqual({ build: false, addon: '{"name":"node-addon-api"}' })
  expect(readFileSync(join(source, 'build/Release/pty.node'), 'utf8')).toBe('electron addon')
  expect(existsSync(join(source, 'prebuilds/linux-x64'))).toBe(false)
})

it('stages shipped lib JS, the selected addon, an executable spawn-helper, LICENSE and the marker', () => {
  const packageRoot = join(base, 'package')
  for (const name of ['index.js', 'unixTerminal.js', 'terminal.test.js', 'index.js.map'])
    write(join(packageRoot, 'lib', name), name)
  write(join(packageRoot, 'lib/shared/conout.js'), 'nested')
  write(join(packageRoot, 'LICENSE'), 'MIT')
  const binary = join(base, 'binary')
  write(join(binary, 'pty.node'), 'addon')
  write(join(binary, 'spawn-helper'), 'helper', 0o644)
  const out = join(base, 'out')
  stageNativeResources({
    packageRoot,
    binary,
    out,
    target: 'darwin-arm64',
    nodeVersion: '24.14.1',
    ptyVersion: '1.1.0',
  })
  expect(tree(out)).toEqual([
    'LICENSE',
    'TARGET.json',
    'build',
    'build/Release',
    'build/Release/pty.node',
    'build/Release/spawn-helper',
    'lib',
    'lib/index.js',
    'lib/unixTerminal.js',
  ])
  expect(readFileSync(join(out, 'build/Release/pty.node'), 'utf8')).toBe('addon')
  expect(readFileSync(join(out, 'build/Release/spawn-helper'), 'utf8')).toBe('helper')
  expect(statSync(join(out, 'build/Release/spawn-helper')).mode & 0o777).toBe(0o755)
  expect(readFileSync(join(out, 'LICENSE'), 'utf8')).toBe('MIT')
  expect(readFileSync(join(out, 'TARGET.json'), 'utf8')).toBe(
    '{"target":"darwin-arm64","node":"24.14.1","version":"1.1.0"}\n',
  )
  expect(() => validateNative(out, 'darwin-arm64')).not.toThrow()
})

it('stages no spawn-helper when the selected addon folder has none', () => {
  const packageRoot = join(base, 'package')
  write(join(packageRoot, 'lib/index.js'), 'index')
  write(join(packageRoot, 'LICENSE'), 'MIT')
  const binary = join(base, 'binary')
  write(join(binary, 'pty.node'), 'addon')
  const out = join(base, 'out')
  stageNativeResources({
    packageRoot,
    binary,
    out,
    target: 'linux-arm64',
    nodeVersion: '24.14.1',
    ptyVersion: '1.1.0',
  })
  expect(existsSync(join(out, 'build/Release/spawn-helper'))).toBe(false)
  expect(readFileSync(join(out, 'TARGET.json'), 'utf8')).toBe(
    '{"target":"linux-arm64","node":"24.14.1","version":"1.1.0"}\n',
  )
  expect(() => validateNative(out, 'linux-arm64')).not.toThrow()
})
