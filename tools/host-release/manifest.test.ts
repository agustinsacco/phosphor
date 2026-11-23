import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { parseHostReleaseManifest } from '@phosphor/shared/host-release'
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
