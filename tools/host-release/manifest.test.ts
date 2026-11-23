import { execFileSync, spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import {
  type HostReleaseManifestV2,
  HOST_RELEASE_FEATURES,
  hostReleaseManifestV2Name,
  parseHostReleaseManifest,
  parseHostReleaseManifestV2,
} from '@phosphor/shared/host-release'
import { HOST_PROTOCOL_VERSION } from '@phosphor/shared/remote-host'
import { hash, node, root } from './__fixtures__/bundle-fixture'

const dir = mkdtempSync(join(tmpdir(), 'release-manifests-'))
const version = '1.2.3'
const targets = ['linux-x64', 'linux-arm64', 'darwin-arm64', 'darwin-x64']
const artifacts = targets.map((target) => {
  const bytes = Buffer.from(target)
  const file = `phosphor-host-${version}-${target}.tar.gz`
  writeFileSync(join(dir, file), bytes)
  return { target, file, bytes: bytes.length, sha256: hash(bytes) }
})
const v1Path = join(dir, `phosphor-host-${version}.manifest.json`)
beforeAll(() => {
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(dir, 'key')])
  node(
    `import {makeManifest} from './tools/host-release/manifest.mjs'; makeManifest(${JSON.stringify(dir)})`,
    {
      HOST_RELEASE_SIGNING_KEY: readFileSync(join(dir, 'key'), 'utf8'),
      TMPDIR: dir,
    },
  )
})
afterAll(() => rmSync(dir, { recursive: true, force: true }))

it('keeps v1 byte-compatible even with a fourth bundle in the output directory', () => {
  const manifest = {
    schema: 1,
    version,
    protocols: [HOST_PROTOCOL_VERSION],
    node: '24.14.1',
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim(),
    artifacts: artifacts.slice(0, 3),
  }
  const bytes = readFileSync(v1Path, 'utf8')
  expect(bytes).toBe(`${JSON.stringify(manifest, null, 2)}\n`)
  expect(parseHostReleaseManifest(JSON.parse(bytes))).toEqual(manifest)
  expect(parseHostReleaseManifest({ ...manifest, artifacts })).toBeNull()
})

it('signs v2 with the same release identity and metadata, adding features and Intel macOS', () => {
  const path = join(dir, hostReleaseManifestV2Name(version))
  const bytes = readFileSync(path)
  const v1 = JSON.parse(readFileSync(v1Path, 'utf8')) as unknown
  expect(parseHostReleaseManifestV2(JSON.parse(bytes.toString()))).toEqual({
    ...parseHostReleaseManifest(v1),
    schema: 2,
    features: HOST_RELEASE_FEATURES,
    artifacts,
  })
  const signers = join(dir, 'allowed_signers')
  writeFileSync(
    signers,
    `phosphor-release namespaces="phosphor-host-release" ${readFileSync(join(dir, 'key.pub'), 'utf8')}`,
  )
  execFileSync(
    'ssh-keygen',
    [
      '-Y',
      'verify',
      '-f',
      signers,
      '-I',
      'phosphor-release',
      '-n',
      'phosphor-host-release',
      '-s',
      `${path}.sig`,
    ],
    { input: bytes },
  )
})

it('the installer selects Intel from v2, ignoring future targets and fields but not invalid known bundles', () => {
  const manifest = JSON.parse(
    readFileSync(join(dir, hostReleaseManifestV2Name(version)), 'utf8'),
  ) as HostReleaseManifestV2
  const parse = (value: unknown) =>
    spawnSync(
      'awk',
      [
        '-v',
        'schema=2',
        '-v',
        'wanted=darwin-x64',
        '-f',
        join(import.meta.dirname, 'manifest.awk'),
      ],
      { encoding: 'utf8', input: JSON.stringify(value) },
    )
  const extensions = { nested: [null, true, -0.15, 'escaped "quotes"'] }
  const extra = {
    ...manifest,
    extensions,
    artifacts: [{ target: 'future', extensions }, ...manifest.artifacts],
  }
  const parsed = parse(extra)
  expect(parsed.status, parsed.stderr).toBe(0)
  const intel = artifacts[3]!
  expect(parsed.stdout.trim().split('\n')).toEqual([
    version,
    intel.file,
    `${intel.bytes}`,
    intel.sha256,
  ])
  for (const invalid of [
    { ...extra, schema: 1 },
    { ...extra, features: ['duplicate', 'duplicate'] },
    { ...extra, artifacts: [...extra.artifacts, intel] },
    { ...extra, artifacts: [{ ...intel, bytes: '1' }] },
  ])
    expect(parse(invalid).status).not.toBe(0)
})

it('requests v2 first and falls back only on a missing manifest, never a bad signature or server error', () => {
  const home = mkdtempSync(join(dir, 'installer-'))
  const script = join(home, 'install.sh')
  const publicKey = readFileSync(join(dir, 'key.pub'), 'utf8').trim()
  node(
    `import {generateInstaller} from './tools/host-release/installer.mjs'; generateInstaller(${JSON.stringify(script)}, ${JSON.stringify([{ id: 'test', publicKey }])})`,
  )
  const shim = (name: string, body: string) =>
    writeFileSync(join(home, name), `#!/bin/sh\nset -eu\n${body}\n`, { mode: 0o755 })
  shim('uname', 'if [ "$1" = -s ]; then echo "$OS"; else echo x86_64; fi')
  shim('base64', 'exec /usr/bin/base64 -d')
  // Never fetch or extract an archive. Reaching the artifact request proves
  // the signature and the metadata for the simulated platform both passed.
  shim(
    'curl',
    `while [ "$1" != -o ]; do url=$1; shift; done
name=\${url##*/}
printf '%s\\n' "$name" >> "$HOME/calls"
case "$name:$MODE" in
  *.v2.json:missing) printf 404; exit 22 ;;
  *.v2.json:error) printf 500; exit 22 ;;
  *.v2.json.sig:bad-signature) printf invalid > "$2" ;;
  *.tar.gz:*) exit 1 ;;
  *) cp "$RELEASE/$name" "$2" ;;
esac
printf 200`,
  )
  const v1 = `phosphor-host-${version}.manifest.json`
  const v2 = hostReleaseManifestV2Name(version)
  for (const [mode, os, calls] of [
    ['intel', 'Darwin', [v2, `${v2}.sig`, artifacts[3]!.file]],
    ['missing', 'Linux', [v2, v1, `${v1}.sig`, artifacts[0]!.file]],
    ['error', 'Linux', [v2]],
    ['bad-signature', 'Linux', [v2, `${v2}.sig`]],
  ] as const) {
    writeFileSync(join(home, 'calls'), '')
    const result = spawnSync('sh', [script, version], {
      encoding: 'utf8',
      env: {
        HOME: home,
        PATH: `${home}:/usr/bin:/bin`,
        TMPDIR: home,
        OS: os,
        MODE: mode,
        RELEASE: dir,
        PHOSPHOR_HOST_RELEASE_URL: 'https://release.invalid',
      },
    })
    expect(result.status).toBe(1)
    expect(readFileSync(join(home, 'calls'), 'utf8').trim().split('\n'), result.stderr).toEqual(
      calls,
    )
  }
})
