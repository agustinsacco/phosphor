import { execFileSync } from 'node:child_process'
import {
  chmodSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { buildSync } from 'esbuild'
import { afterEach, beforeAll, beforeEach, expect, it } from 'vitest'

let bundle: string
let root: string
let pkg: string
let release: string
let helper: string
beforeAll(() => {
  bundle = buildSync({
    entryPoints: [join(import.meta.dirname, 'native.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
  }).outputFiles[0]!.text
})
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), 'host-native-'))
  pkg = join(root, 'native/node-pty')
  release = join(pkg, 'build/Release')
  helper = join(release, 'spawn-helper')
  mkdirSync(release, { recursive: true })
  writeFileSync(helper, 'helper')
  chmodSync(helper, 0o644)
  mkdirSync(join(pkg, 'lib'))
  writeFileSync(join(pkg, 'lib/index.js'), 'exports.spawn = () => {}')
  writeFileSync(join(root, 'phosphor.mjs'), bundle)
})
afterEach(() => rmSync(root, { force: true, recursive: true }))

function load(prelude = '') {
  return execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '-e',
      `${prelude}
    import { loadHostPty } from './phosphor.mjs'; console.log(typeof loadHostPty()?.spawn)`,
    ],
    {
      cwd: root,
      encoding: 'utf8',
    },
  ).trim()
}

it('repairs a helper installed by the older extractor before the first spawn', () => {
  expect(load()).toBe('function')
  expect(statSync(helper).mode & 0o777).toBe(0o755)
})

it.each(['package', 'parent', 'leaf'] as const)('skips repair through a %s symlink', (part) => {
  const path = { package: pkg, parent: release, leaf: helper }[part]
  renameSync(path, path + '-fixture')
  symlinkSync(path + '-fixture', path)
  load()
  expect(statSync(helper).mode & 0o777).toBe(0o644)
})

it('skips a multiply linked helper', () => {
  linkSync(helper, join(root, 'second-name'))
  load()
  expect(statSync(helper).mode & 0o777).toBe(0o644)
})

it('skips repair when the helper does not belong to the effective uid', () => {
  load(`process.geteuid = () => ${statSync(helper).uid + 1};`)
  expect(statSync(helper).mode & 0o777).toBe(0o644)
})
