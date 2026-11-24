import { Buffer } from 'node:buffer'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync, lstatSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve } from 'node:path'
import { parseArgs } from 'node:util'
import process from 'node:process'
import { root, pin, contract, sha256, isEntryPoint } from './common.mjs'

export function signManifest(bytes, namespace = contract.HOST_RELEASE_NAMESPACE) {
  const key = process.env.HOST_RELEASE_SIGNING_KEY
  if (!key) throw new Error('HOST_RELEASE_SIGNING_KEY is required')
  const temp = mkdtempSync(join(tmpdir(), 'phosphor-sign-'))
  try {
    const path = join(temp, 'key')
    // A secret store can drop the final newline (gh secret set from stdin does),
    // and OpenSSH refuses a private key without one, so restore LF line ends.
    const normalized = `${key.replace(/\r\n?/g, '\n').replace(/\n*$/, '')}\n`
    writeFileSync(path, normalized, { mode: 0o600, flag: 'wx' })
    const publicKey = execFileSync('ssh-keygen', ['-y', '-f', path], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    if (!publicKey.startsWith('ssh-ed25519 ')) throw new Error()
    return execFileSync(
      'ssh-keygen',
      ['-Y', 'sign', '-f', path, '-n', namespace, '-O', 'hashalg=sha512'],
      {
        input: bytes,
        stdio: ['pipe', 'pipe', 'pipe'],
      },
    )
  } catch {
    throw new Error('Release signing failed')
  } finally {
    rmSync(temp, { recursive: true, force: true })
  }
}
export function makeManifest(out) {
  const version = process.env.HOST_RELEASE_VERSION
  if (!version || !contract.HOST_RELEASE_VERSION_PATTERN.test(version))
    throw new Error('Invalid HOST_RELEASE_VERSION')
  const artifacts = contract.HOST_RELEASE_TARGETS_V2.map((target) => {
    const file = `phosphor-host-${version}-${target}.tar.gz`
    const path = join(out, file)
    const stat = lstatSync(path)
    if (!stat.isFile() || stat.size < 1 || stat.size > contract.HOST_RELEASE_ARTIFACT_MAX_BYTES)
      throw new Error('Invalid release artifact')
    const bytes = readFileSync(path)
    return { target, file, bytes: bytes.length, sha256: sha256(bytes) }
  })
  const shared = {
    version,
    protocols: [contract.HOST_PROTOCOL_VERSION],
    node: pin.version,
    sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
      cwd: root,
      encoding: 'utf8',
    }).trim(),
  }
  const manifest = {
    schema: 1,
    ...shared,
    artifacts: artifacts.filter(({ target }) => contract.HOST_RELEASE_TARGETS.includes(target)),
  }
  const v2 = { schema: 2, ...shared, features: contract.HOST_RELEASE_FEATURES, artifacts }
  if (!contract.parseHostReleaseManifestV2(v2)) throw new Error('Invalid v2 release metadata')
  if (!contract.parseHostReleaseManifest(manifest)) throw new Error('Invalid release metadata')
  const path = join(out, `phosphor-host-${version}.manifest.json`)
  writeSignedManifest(path, manifest)
  writeSignedManifest(join(out, contract.hostReleaseManifestV2Name(version)), v2)
  return path
}
function writeSignedManifest(path, manifest) {
  const bytes = Buffer.from(`${JSON.stringify(manifest, null, 2)}\n`)
  const signature = signManifest(bytes)
  writeFileSync(path, bytes)
  writeFileSync(`${path}.sig`, signature)
}
if (isEntryPoint(import.meta.url)) {
  const { values } = parseArgs({ options: { out: { type: 'string' } } })
  makeManifest(resolve(values.out ?? '.'))
}
