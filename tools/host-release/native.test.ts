import { execFileSync, spawnSync } from 'node:child_process'
import {
  chmodSync,
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
const dir = mkdtempSync(join(tmpdir(), 'host-native-test-'))
const root = resolve(import.meta.dirname, '../..')
const native = join(dir, 'native')
const target = `${process.platform}-${process.arch}`
const run = (script: string) =>
  spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    cwd: root,
    encoding: 'utf8',
    env: { ...process.env, HOST_RELEASE_VERSION: '1.2.3' },
  })
beforeAll(() => {
  // Fetch the pinned, hash-verified Node, not Electron's ABI or the test runner's Node.
  const result = run(
    `import {nodeArchive} from './tools/host-release/build-bundle.mjs'; import {buildNative} from './tools/host-release/build-native.mjs'; import {execFileSync} from 'node:child_process'; const cache=${JSON.stringify(dir)}; await nodeArchive(${JSON.stringify(target)},cache); execFileSync('tar',['-xzf',cache+'/node-v24.14.1-${target}.tar.gz','-C',cache]); buildNative(${JSON.stringify(native)},cache+'/node-v24.14.1-${target}/bin/node')`,
  )
  expect(result.status, result.stderr).toBe(0)
}, 60000)
afterAll(() => rmSync(dir, { recursive: true, force: true }))
it('loads and spawns with pinned Node and records the actual runner target', () => {
  expect(JSON.parse(readFileSync(join(native, 'TARGET.json'), 'utf8'))).toEqual({
    target,
    node: '24.14.1',
    version: '1.1.0',
  })
})
it('rejects cross-target native trees before bundling', () => {
  const wrong = target === 'linux-x64' ? 'linux-arm64' : 'linux-x64'
  const result = run(
    `import {buildBundle} from './tools/host-release/build-bundle.mjs'; await buildBundle(${JSON.stringify(wrong)},${JSON.stringify(join(dir, 'out'))},undefined,undefined,${JSON.stringify(native)})`,
  )
  expect(result.status).not.toBe(0)
  expect(result.stderr).toContain('Native target mismatch')
})
it('keeps spawn-helper executable in deterministic archives and inventories native resources', () => {
  const stage = join(dir, 'stage')
  mkdirSync(join(stage, 'lib/native'), { recursive: true })
  cpSync(native, join(stage, 'lib/native/node-pty'), { recursive: true })
  // The archive overrides input modes rather than trusting a copied artifact.
  const helper = join(stage, 'lib/native/node-pty/build/Release/spawn-helper')
  writeFileSync(helper, 'helper')
  chmodSync(helper, 0o644)
  const result = run(
    `import {archive} from './tools/host-release/archive.mjs'; import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(join(dir, 'native.tar.gz'))},archive(${JSON.stringify(stage)}))`,
  )
  expect(result.status, result.stderr).toBe(0)
  const listing = execFileSync('tar', ['-tvzf', join(dir, 'native.tar.gz')], { encoding: 'utf8' })
  expect(listing.split('\n').find((l) => l.includes('spawn-helper'))).toMatch(/^-rwxr-xr-x/)
  const parent = join(dir, 'esm-parent')
  mkdirSync(parent)
  writeFileSync(join(parent, 'package.json'), '{"type":"module"}')
  const out = join(parent, 'bundle')
  const build = spawnSync(
    process.execPath,
    ['apps/host/scripts/build.mjs', '--out', out, '--native', native, '--target', target],
    { cwd: root, encoding: 'utf8' },
  )
  expect(build.status, build.stderr).toBe(0)
  const cli = execFileSync(
    join(dir, `node-v24.14.1-${target}/bin/node`),
    [join(out, 'phosphor.mjs'), 'version'],
    { encoding: 'utf8' },
  )
  expect(cli).toContain('phosphor')
  const loaded = execFileSync(
    join(dir, `node-v24.14.1-${target}/bin/node`),
    [
      '-e',
      `const p = require(${JSON.stringify(join(out, 'native/node-pty/lib/index.js'))}); console.log(typeof p.spawn)`,
    ],
    { encoding: 'utf8' },
  )
  expect(loaded.trim()).toBe('function')
  expect(JSON.parse(readFileSync(join(out, 'native/node-pty/package.json'), 'utf8')).type).toBe(
    'commonjs',
  )
  const info = JSON.parse(readFileSync(join(out, 'BUILD-INFO.json'), 'utf8'))
  expect(info.files).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ path: 'native/node-pty/build/Release/pty.node' }),
      expect.objectContaining({ path: 'native/node-pty/LICENSE' }),
    ]),
  )
})
