import { spawnSync } from 'node:child_process'
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  realpathSync,
  statSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  type BundleFixture,
  disposeBundleFixture,
  hash,
  hook,
  install,
  launcher,
  metadata,
  prepareHome,
  prepareRelease,
  rerun,
  setupBundleFixture,
  target,
} from './bundle-fixture'

let fixture: BundleFixture
beforeAll(() => {
  fixture = setupBundleFixture()
}, 120_000)
afterAll(() => disposeBundleFixture(fixture))

const versioned = 'phosphor-host-1.2.3.manifest.json'
const bundleName = `phosphor-host-1.2.3-${target}.tar.gz`
const keyBody = (publicKey: string) => publicKey.split(' ').slice(0, 2).join(' ')
/** Checks a prepared manifest the way install.sh does, against one public key. */
function verifies(release: string, publicKey: string, manifest = versioned) {
  const signers = join(mkdtempSync(join(fixture.dir, 'signers-')), 'allowed_signers')
  writeFileSync(
    signers,
    `phosphor-release namespaces="phosphor-host-release" ${keyBody(publicKey)}\n`,
  )
  const file = join(release, manifest)
  const args = [
    '-Y',
    'verify',
    '-f',
    signers,
    '-I',
    'phosphor-release',
    '-n',
    'phosphor-host-release',
  ]
  return (
    spawnSync('ssh-keygen', [...args, '-s', `${file}.sig`], { input: readFileSync(file) })
      .status === 0
  )
}
const signatureHash = (release: string) => {
  const armored = readFileSync(join(release, `${versioned}.sig`), 'utf8').split('\n')
  const sshsig = Buffer.from(armored.slice(1, -2).join(''), 'base64')
  return ['sha256', 'sha512'].filter((name) => sshsig.includes(name))
}

describe('bundle fixture', { timeout: 60_000 }, () => {
  it('keeps every path, key and bundle inside one fixture and apart from any other', () => {
    const other = setupBundleFixture()
    try {
      expect(other.dir).not.toBe(fixture.dir)
      for (const each of [fixture, other]) {
        expect(each.dir.startsWith(`${realpathSync(tmpdir())}/`)).toBe(true)
        for (const path of [each.script, each.cache, each.out])
          expect(path.startsWith(`${each.dir}/`)).toBe(true)
      }
      expect(other.publicKey).not.toBe(fixture.publicKey)
      expect(other.privateKey).not.toBe(fixture.privateKey)
      const installer = readFileSync(fixture.script, 'utf8')
      expect(installer).toContain(keyBody(fixture.publicKey))
      expect(installer).not.toContain(keyBody(other.publicKey))
      const original = fixture.bundle
      try {
        fixture.bundle = Buffer.from('swapped bundle')
        expect(metadata(fixture).artifacts).toEqual([
          { target, file: bundleName, bytes: 14, sha256: hash(fixture.bundle) },
        ])
        expect(metadata(other).artifacts[0]?.sha256).toBe(hash(other.bundle))
        expect(readFileSync(join(prepareRelease(fixture), bundleName), 'utf8')).toBe(
          'swapped bundle',
        )
      } finally {
        fixture.bundle = original
      }
      disposeBundleFixture(other)
      expect(existsSync(other.dir)).toBe(false)
      expect(existsSync(fixture.script)).toBe(true)
      expect(() => disposeBundleFixture(undefined)).not.toThrow()
    } finally {
      disposeBundleFixture(other)
    }
  })
  it('writes exactly the manifest it signs, with the chosen key, namespace and hash', () => {
    const otherKey = readFileSync(join(fixture.dir, 'other.pub'), 'utf8')
    const release = prepareRelease(fixture)
    expect(readdirSync(release).sort()).toEqual([bundleName, versioned, `${versioned}.sig`])
    expect(readFileSync(join(release, versioned), 'utf8')).toBe(
      `${JSON.stringify(metadata(fixture), null, 2)}\n`,
    )
    expect(readFileSync(join(release, bundleName)).equals(fixture.bundle)).toBe(true)
    expect(verifies(release, fixture.publicKey)).toBe(true)
    expect(verifies(release, otherKey)).toBe(false)
    expect(signatureHash(release)).toEqual(['sha512'])
    const foreign = prepareRelease(fixture, { key: 'other' })
    expect([verifies(foreign, fixture.publicKey), verifies(foreign, otherKey)]).toEqual([
      false,
      true,
    ])
    expect(verifies(prepareRelease(fixture, { namespace: 'wrong' }), fixture.publicKey)).toBe(false)
    expect(signatureHash(prepareRelease(fixture, { algorithm: 'sha256' }))).toEqual(['sha256'])
    const flipped = prepareRelease(fixture, { flip: true })
    expect(readFileSync(join(flipped, versioned), 'utf8')).toContain('"version": "1.2.4"')
    expect(verifies(flipped, fixture.publicKey)).toBe(false)
    const latest = prepareRelease(fixture, { requested: '' })
    expect(existsSync(join(latest, versioned))).toBe(false)
    expect(verifies(latest, fixture.publicKey, 'phosphor-host.manifest.json')).toBe(true)
    const rewritten = prepareRelease(fixture, {
      change: (m) => {
        m.protocols = [1, 2]
      },
      rawManifest: (json) => json.replace('"schema": 1', '"schema": 2'),
    })
    const text = readFileSync(join(rewritten, versioned), 'utf8')
    expect(JSON.parse(text)).toMatchObject({ schema: 2, protocols: [1, 2] })
    expect(verifies(rewritten, fixture.publicKey)).toBe(true)
  })
  it('prepares a home whose old install and launcher every case starts from', () => {
    const { home, temp, old } = prepareHome(fixture)
    expect(home.startsWith(`${fixture.dir}/`)).toBe(true)
    expect(readdirSync(temp)).toEqual([])
    expect(readdirSync(old).sort()).toEqual(['current', 'versions'])
    expect(readlinkSync(join(old, 'current'))).toBe('versions/old')
    expect(readFileSync(join(old, 'versions/old/marker'), 'utf8')).toBe('unchanged')
    expect(readlinkSync(launcher(home))).toBe(join(old, 'current/bin/phosphor'))
  })
  it('shims a command for one home only and still runs the real command', () => {
    const first = mkdtempSync(join(fixture.dir, 'hook-'))
    const second = mkdtempSync(join(fixture.dir, 'hook-'))
    const path = hook(first, 'mkdir', `printf '%s\\n' "$*" >> '${first}/calls'`)
    expect(path).toBe(`${join(first, 'commands')}:${process.env.PATH}`)
    expect(statSync(join(first, 'commands/mkdir')).mode & 0o111).toBe(0o111)
    const make = (folder: string, env: NodeJS.ProcessEnv) =>
      spawnSync('sh', ['-c', 'mkdir "$1"', 'sh', folder], { env: { ...process.env, ...env } })
    expect(make(join(first, 'made'), { PATH: path }).status).toBe(0)
    expect(existsSync(join(first, 'made'))).toBe(true)
    expect(make(join(second, 'made'), {}).status).toBe(0)
    expect(readFileSync(join(first, 'calls'), 'utf8')).toBe(`${join(first, 'made')}\n`)
    expect(existsSync(join(second, 'commands'))).toBe(false)
    hook(first, 'mv', ':')
    expect(readdirSync(join(first, 'commands')).sort()).toEqual(['mkdir', 'mv'])
  })
  it('installs from a prepared release, checks its invariants, and reruns it', () => {
    let release = ''
    const { result, home, old } = install(fixture, {
      prepare: (_home, folder) => {
        release = folder
        return {}
      },
    })
    expect(result.status, result.stderr).toBe(0)
    expect(readlinkSync(join(old, 'current'))).toBe('versions/1.2.3')
    const again = rerun(fixture, home, release)
    expect(again.status, again.stderr).toBe(0)
    expect(again.stdout).toContain('already installed')
    // KEEP_LOCK=1 claims the lock survives; a released lock must fail the helper's own check.
    expect(() => install(fixture, { prepare: () => ({ KEEP_LOCK: '1' }) })).toThrow(
      /expected false to be true/,
    )
  })
  it.each(['ssh-keygen', 'tar'])('removes its temp root when %s fails during setup', (command) => {
    const parent = mkdtempSync(join(fixture.dir, 'setup-temp-'))
    const shims = mkdtempSync(join(fixture.dir, 'setup-shims-'))
    const calls = join(shims, 'calls')
    writeFileSync(join(shims, command), `#!/bin/sh\nprintf '%s\\n' "$*" >> '${calls}'\nexit 1\n`, {
      mode: 0o755,
    })
    const saved = { TMPDIR: process.env.TMPDIR, PATH: process.env.PATH }
    process.env.TMPDIR = parent
    process.env.PATH = `${shims}:${saved.PATH}`
    try {
      expect(() => setupBundleFixture()).toThrow()
    } finally {
      for (const [name, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[name]
        else process.env[name] = value
      }
    }
    // The failing command ran on a path inside the redirected temp root, which is now empty.
    expect(readFileSync(calls, 'utf8')).toContain(`${parent}/`)
    expect(readdirSync(parent)).toEqual([])
  })
})
