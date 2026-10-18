import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import type { HostReleaseKey, HostReleaseManifest } from '@phosphor/shared/host-release'

/** A local release mirror: the asset folder and the throwaway key that signs it. */
export interface ReleaseMirror {
  assets: string
  /** Private key path; its `.pub` sits beside it. */
  key: string
  /** The trusted keys an update checks the mirror against. */
  keys: HostReleaseKey[]
}

/** One version's tree under `lib/versions/<version>`, as the installer leaves it. */
export function installVersion(lib: string, version: string): string {
  const folder = join(lib, 'versions', version)
  for (const name of ['VERSION', 'bin/phosphor', 'node/bin/node', 'lib/phosphor.mjs']) {
    mkdirSync(join(folder, name, '..'), { recursive: true })
    writeFileSync(join(folder, name), name === 'VERSION' ? version + '\n' : 'test')
  }
  return folder
}

/** Install 1.0.0 as `current`, with the `~/.local/bin/phosphor` launcher reaching it through `current`. */
export function installCurrent(home: string, lib: string): string {
  const old = installVersion(lib, '1.0.0')
  symlinkSync('versions/1.0.0', join(lib, 'current'))
  mkdirSync(join(home, '.local/bin'), { recursive: true })
  symlinkSync(join(lib, 'current/bin/phosphor'), join(home, '.local/bin/phosphor'))
  return old
}

/** An empty `assets` mirror in `home`, signed by a fresh Ed25519 key named `test`. */
export function createReleaseMirror(home: string): ReleaseMirror {
  const assets = join(home, 'assets')
  mkdirSync(assets)
  const key = join(home, 'throwaway')
  execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', key])
  return {
    assets,
    key,
    keys: [{ id: 'test', publicKey: readFileSync(key + '.pub', 'utf8').trim() }],
  }
}

/** The manifest for one linux-x64 artifact of exactly these bytes. */
export function releaseManifest(version: string, file: string, bytes: Buffer): HostReleaseManifest {
  return {
    schema: 1,
    version,
    protocols: [1],
    node: '24.14.1',
    sourceCommit: 'a'.repeat(40),
    artifacts: [
      {
        target: 'linux-x64',
        file,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      },
    ],
  }
}

/**
 * Publish `bytes` as `version` into the mirror. `change` may fault the
 * manifest before it is written and signed; the artifact keeps its original
 * name and bytes. `request` names a per-tag manifest. Returns the manifest path.
 */
export function publishRelease(
  mirror: ReleaseMirror,
  version: string,
  bytes: Buffer,
  change: (manifest: HostReleaseManifest) => void,
  request?: string,
): string {
  const file = `phosphor-host-${version}-linux-x64.tar.gz`
  const manifest = releaseManifest(version, file, bytes)
  change(manifest)
  const path = join(
    mirror.assets,
    request ? `phosphor-host-${request}.manifest.json` : 'phosphor-host.manifest.json',
  )
  writeFileSync(path, JSON.stringify(manifest) + '\n')
  rmSync(path + '.sig', { force: true })
  execFileSync(
    'ssh-keygen',
    ['-Y', 'sign', '-f', mirror.key, '-n', 'phosphor-host-release', path],
    {
      stdio: 'pipe',
    },
  )
  writeFileSync(join(mirror.assets, file), bytes)
  return path
}
