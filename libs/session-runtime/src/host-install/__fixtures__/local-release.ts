import { execFileSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { join } from 'node:path'
import { pathToFileURL } from 'node:url'
import { gzipSync } from 'node:zlib'
import {
  HOST_RELEASE_MANIFEST_V2,
  HOST_RELEASE_TARGETS,
  type HostReleaseKey,
  type HostReleaseTargetV2,
} from '@phosphor/shared/host-release'
import { tar } from './tar'

/** The scripts inside a fake bundle. `node/bin/node` answers the staged probe. */
export interface BundleFiles {
  'bin/phosphor'?: string
  'node/bin/node'?: string
  'lib/phosphor.mjs'?: string
}

export interface LocalPublish {
  version?: string
  features?: string[]
  /** Reported by the bundle's `version --json`; defaults to `features`. */
  bundleFeatures?: string[]
  targets?: HostReleaseTargetV2[]
  files?: BundleFiles
  v1?: 'same' | 'absent' | 'other-commit'
  v2?: 'signed' | 'absent' | 'unsigned' | 'wrong-key' | 'invalid'
}

/** A `file:` release folder for `host-latest`, signed by throwaway keys under `root`. */
export interface LocalReleaseMirror {
  assets: string
  env: { PHOSPHOR_HOST_RELEASE_URL: string }
  keys: HostReleaseKey[]
  publish(options?: LocalPublish): void
}

/** A `version --json` probe answer, as a POSIX script. */
export const probeNode = (version: string, features: string[]): string =>
  `#!/bin/sh\n[ "$2" = version ] && [ "$3" = --json ] || exit 64\necho '${JSON.stringify({ hostVersion: version, protocolVersion: 1, features })}'\n`

function bundle(version: string, files: BundleFiles, features: string[]): Buffer {
  return gzipSync(
    tar([
      { name: 'VERSION', text: `${version}\n` },
      { name: 'bin/phosphor', text: files['bin/phosphor'] ?? '#!/bin/sh\nexit 0\n' },
      { name: 'node/bin/node', text: files['node/bin/node'] ?? probeNode(version, features) },
      { name: 'node/LICENSE', text: 'test' },
      { name: 'lib/phosphor.mjs', text: files['lib/phosphor.mjs'] ?? '' },
    ]),
  )
}

export function localReleaseMirror(root: string): LocalReleaseMirror {
  const assets = join(root, 'assets')
  mkdirSync(assets, { recursive: true })
  for (const name of ['release-key', 'other-key'])
    execFileSync('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', join(root, name)])
  const keys = [
    { id: 'test', publicKey: readFileSync(join(root, 'release-key.pub'), 'utf8').trim() },
  ]
  const write = (name: string, value: unknown, key: string | null) => {
    const path = join(assets, name)
    rmSync(path + '.sig', { force: true })
    writeFileSync(path, typeof value === 'string' ? value : JSON.stringify(value) + '\n')
    if (key)
      execFileSync(
        'ssh-keygen',
        ['-Y', 'sign', '-f', join(root, key), '-n', 'phosphor-host-release', path],
        {
          stdio: 'pipe',
        },
      )
  }
  const publish = (options: LocalPublish = {}) => {
    const version = options.version ?? '1.2.3'
    const features = options.features ?? ['local-mode', 'owner-socket']
    const bytes = bundle(version, options.files ?? {}, options.bundleFeatures ?? features)
    const artifacts = (options.targets ?? ['darwin-arm64', 'linux-x64']).map((target) => {
      const file = `phosphor-host-${version}-${target}.tar.gz`
      writeFileSync(join(assets, file), bytes)
      return {
        target,
        file,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      }
    })
    const shared = { version, protocols: [1], node: '24.14.1', sourceCommit: 'a'.repeat(40) }
    for (const name of [HOST_RELEASE_MANIFEST_V2, 'phosphor-host.manifest.json'])
      for (const path of [name, `${name}.sig`]) rmSync(join(assets, path), { force: true })
    const v1 = options.v1 ?? 'same'
    if (v1 !== 'absent')
      write(
        'phosphor-host.manifest.json',
        {
          schema: 1,
          ...shared,
          ...(v1 === 'other-commit' && { sourceCommit: 'b'.repeat(40) }),
          artifacts: artifacts.filter((a) =>
            (HOST_RELEASE_TARGETS as readonly string[]).includes(a.target),
          ),
        },
        'release-key',
      )
    const v2 = options.v2 ?? 'signed'
    if (v2 === 'absent') return
    const manifest =
      v2 === 'invalid' ? { schema: 2, ...shared } : { schema: 2, ...shared, features, artifacts }
    write(
      HOST_RELEASE_MANIFEST_V2,
      manifest,
      v2 === 'unsigned' ? null : v2 === 'wrong-key' ? 'other-key' : 'release-key',
    )
  }
  return { assets, env: { PHOSPHOR_HOST_RELEASE_URL: pathToFileURL(assets).href }, keys, publish }
}
