import { execFileSync, spawnSync } from 'node:child_process'
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { createHash } from 'node:crypto'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

// Pins the shipping release path through its public entries, with its own keys and folders:
// generateInstaller and buildBundle, the manifest CLI that signs, then the generated install.sh.
// It shares nothing with bundles.test.ts on purpose.
const root = resolve(import.meta.dirname, '../..')
const target = `${process.platform}-${process.arch}`
const nodeVersion = (
  JSON.parse(readFileSync(join(root, 'tools/host-release/node.json'), 'utf8')) as {
    version: string
  }
).version
const manifestName = 'phosphor-host-1.2.3.manifest.json'
const bundleName = `phosphor-host-1.2.3-${target}.tar.gz`
const releaseEnv = (extra: NodeJS.ProcessEnv = {}) => ({
  ...process.env,
  HOST_RELEASE_VERSION: '1.2.3',
  ...extra,
})
let dir = ''
let installer = ''
let release = ''
let foreign = ''
let signTemp = ''
let privateKey = ''

function runModule(source: string) {
  execFileSync(process.execPath, ['--input-type=module', '-e', source], {
    cwd: root,
    stdio: ['ignore', 'pipe', 'pipe'],
    env: releaseEnv(),
  })
}
function stageArtifacts(folder: string, bundle?: string) {
  mkdirSync(folder)
  for (const each of ['linux-x64', 'linux-arm64', 'darwin-arm64'])
    writeFileSync(join(folder, `phosphor-host-1.2.3-${each}.tar.gz`), 'other target artifact')
  if (bundle) cpSync(bundle, join(folder, bundleName))
}
function signRelease(folder: string, key: string) {
  return spawnSync(process.execPath, ['tools/host-release/manifest.mjs', '--out', folder], {
    cwd: root,
    encoding: 'utf8',
    env: releaseEnv({ HOST_RELEASE_SIGNING_KEY: key, TMPDIR: signTemp }),
  })
}
function oldInstall() {
  const home = mkdtempSync(join(dir, 'home-'))
  const lib = join(home, '.local/lib/phosphor-host')
  mkdirSync(join(lib, 'versions/old'), { recursive: true })
  writeFileSync(join(lib, 'versions/old/marker'), 'unchanged')
  symlinkSync('versions/old', join(lib, 'current'))
  mkdirSync(join(home, '.local/bin'))
  symlinkSync(join(lib, 'current/bin/phosphor'), join(home, '.local/bin/phosphor'))
  mkdirSync(join(home, 'temp'))
  return { home, lib, launcher: join(home, '.local/bin/phosphor') }
}
function runInstaller(home: string, from: string) {
  return spawnSync('sh', [installer, '1.2.3'], {
    encoding: 'utf8',
    env: {
      ...process.env,
      HOME: home,
      TMPDIR: join(home, 'temp'),
      PHOSPHOR_HOST_RELEASE_URL: `file://${from}`,
    },
  })
}
function tampered(kind: 'manifest' | 'artifact' | 'signer') {
  const folder = mkdtempSync(join(dir, `tampered-${kind}-`))
  cpSync(kind === 'signer' ? foreign : release, folder, { recursive: true })
  if (kind === 'manifest') {
    const path = join(folder, manifestName)
    const edited = readFileSync(path, 'utf8').replace(
      `"node": "${nodeVersion}"`,
      '"node": "99.0.0"',
    )
    expect(edited).not.toBe(readFileSync(path, 'utf8'))
    writeFileSync(path, edited)
  } else if (kind === 'artifact') {
    const path = join(folder, bundleName)
    const bytes = readFileSync(path)
    const middle = bytes.length >> 1
    bytes.writeUInt8(bytes.readUInt8(middle) ^ 0xff, middle)
    writeFileSync(path, bytes)
  }
  return folder
}

beforeAll(() => {
  dir = realpathSync(mkdtempSync(join(tmpdir(), 'host-release-characterization-')))
  for (const name of ['key', 'other'])
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, name)])
  privateKey = readFileSync(join(dir, 'key'), 'utf8')
  const publicKey = readFileSync(join(dir, 'key.pub'), 'utf8').trim()
  installer = join(dir, 'install.sh')
  runModule(
    `import {generateInstaller} from './tools/host-release/installer.mjs'; generateInstaller(${JSON.stringify(installer)}, ${JSON.stringify([{ id: 'characterization', publicKey }])})`,
  )
  const prefix = `node-v${nodeVersion}-${target}`
  const stage = join(dir, 'node-stage')
  mkdirSync(join(stage, prefix, 'bin'), { recursive: true })
  cpSync(process.execPath, join(stage, prefix, 'bin/node'))
  writeFileSync(join(stage, prefix, 'LICENSE'), 'Characterization runtime license\n')
  const cache = join(dir, 'cache')
  mkdirSync(cache)
  const archived = join(cache, `${prefix}.tar.gz`)
  runModule(
    `import {archive} from './tools/host-release/archive.mjs'; import {writeFileSync} from 'node:fs'; writeFileSync(${JSON.stringify(archived)}, archive(${JSON.stringify(stage)}))`,
  )
  const sha256 = createHash('sha256').update(readFileSync(archived)).digest('hex')
  const pin = { version: nodeVersion, archives: { [target]: sha256 } }
  const out = join(dir, 'out')
  runModule(
    `import {buildBundle} from './tools/host-release/build-bundle.mjs'; await buildBundle(${JSON.stringify(target)}, ${JSON.stringify(out)}, ${JSON.stringify(cache)}, ${JSON.stringify(pin)})`,
  )
  signTemp = join(dir, 'sign-temp')
  mkdirSync(signTemp)
  release = join(dir, 'release')
  stageArtifacts(release, join(out, bundleName))
  const signed = signRelease(release, privateKey)
  expect(signed.status, signed.stderr).toBe(0)
  foreign = join(dir, 'foreign')
  stageArtifacts(foreign, join(out, bundleName))
  const unpinned = signRelease(foreign, readFileSync(join(dir, 'other'), 'utf8'))
  expect(unpinned.status, unpinned.stderr).toBe(0)
}, 180_000)
afterAll(() => {
  if (dir) rmSync(dir, { recursive: true, force: true })
})

describe('Host release install through its public entries', { timeout: 60_000 }, () => {
  it('installs a release signed by the pinned key and publishes its version', () => {
    const { home, lib, launcher } = oldInstall()
    const result = runInstaller(home, release)
    expect(result.status, result.stderr).toBe(0)
    expect(result.stdout).toContain('Installed Phosphor Host.')
    expect(readlinkSync(join(lib, 'current'))).toBe('versions/1.2.3')
    expect(readFileSync(join(lib, 'versions/1.2.3/VERSION'), 'utf8')).toBe('1.2.3\n')
    expect(readdirSync(join(lib, 'versions')).sort()).toEqual(['1.2.3', 'old'])
    expect(readFileSync(join(lib, 'versions/old/marker'), 'utf8')).toBe('unchanged')
    expect(readlinkSync(launcher)).toBe(join(lib, 'current/bin/phosphor'))
    const version = execFileSync(launcher, ['version'], {
      encoding: 'utf8',
      env: { HOME: home, PATH: '/usr/bin:/bin' },
    })
    expect(version).toContain('1.2.3')
  })
  it.each(['manifest', 'artifact', 'signer'] as const)(
    'refuses a release with a tampered %s without changing the old install',
    (kind) => {
      const { home, lib, launcher } = oldInstall()
      const result = runInstaller(home, tampered(kind))
      expect(result.status).not.toBe(0)
      expect(result.stderr).toContain('Host installation failed; existing install is unchanged.')
      expect(result.stdout).toBe('')
      expect(readlinkSync(join(lib, 'current'))).toBe('versions/old')
      expect(readdirSync(join(lib, 'versions'))).toEqual(['old'])
      expect(readFileSync(join(lib, 'versions/old/marker'), 'utf8')).toBe('unchanged')
      expect(readlinkSync(launcher)).toBe(join(lib, 'current/bin/phosphor'))
      expect(readdirSync(lib).sort()).toEqual(['current', 'versions'])
    },
  )
  it('leaves no install lock, staging folder or installer temp after success and failure', () => {
    const recovered = oldInstall()
    mkdirSync(join(recovered.lib, '.install-lock'))
    writeFileSync(join(recovered.lib, '.install-lock/pid'), '2147483647\n')
    const conflicting = oldInstall()
    mkdirSync(join(conflicting.lib, 'versions/1.2.3'))
    writeFileSync(join(conflicting.lib, 'versions/1.2.3/VERSION'), 'wrong')
    const rejected = oldInstall()
    const runs = [
      { ...recovered, result: runInstaller(recovered.home, release), status: 0 },
      { ...conflicting, result: runInstaller(conflicting.home, release), status: 1 },
      { ...rejected, result: runInstaller(rejected.home, tampered('artifact')), status: 1 },
    ]
    expect(runs[1]?.result.stderr).toContain(join(conflicting.lib, 'versions/1.2.3'))
    expect(readFileSync(join(conflicting.lib, 'versions/1.2.3/VERSION'), 'utf8')).toBe('wrong')
    for (const { home, lib, result, status } of runs) {
      expect(result.status, result.stderr).toBe(status)
      expect(readdirSync(join(home, 'temp'))).toEqual([])
      expect(readdirSync(lib).sort()).toEqual(['current', 'versions'])
      expect(result.stdout + result.stderr).not.toContain(privateKey.trim())
    }
  })
  it('signs with an environment-only key and removes its key copy on success and failure', () => {
    expect(readdirSync(signTemp)).toEqual([])
    for (const name of readdirSync(release))
      expect(readFileSync(join(release, name)).includes(Buffer.from(privateKey.trim()))).toBe(false)
    const unsigned = join(dir, 'unsigned')
    stageArtifacts(unsigned)
    const refused = signRelease(unsigned, 'invalid-test-key')
    expect(refused.status).not.toBe(0)
    expect(refused.stderr).toContain('Release signing failed')
    expect(refused.stdout + refused.stderr).not.toContain('invalid-test-key')
    expect(readdirSync(signTemp)).toEqual([])
    expect(readdirSync(unsigned).filter((name) => name.includes('manifest'))).toEqual([])
  })
})
