import { lstatSync } from 'node:fs'
import { join } from 'node:path'
import {
  HOST_RELEASE_KEYS,
  HOST_RELEASE_MANIFEST_MAX_BYTES,
  type HostReleaseKey,
} from '@phosphor/shared/host-release'
import { HOST_PROTOCOL_VERSION } from '@phosphor/shared/remote-host'
import { decompressRelease, extractRelease } from './archive'
import { downloadRelease, releaseUrl } from './download'
import { readBounded } from './files'
import { verifyReleaseArtifact, verifyReleaseManifest } from './verify'

export class UpdateFailure extends Error {
  constructor(
    message: string,
    readonly exitCode = 75,
  ) {
    super(message)
  }
}

export function compareVersions(a: string, b: string): number {
  const x = a.split('.').map(Number),
    y = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0)
    if (d) return d
  }
  return 0
}

/** Where an update is, for a terminal to show while it works. Plain output ignores it. */
export type UpdateStep =
  | { step: 'check' }
  | { step: 'found'; version: string; installed: string }
  | { step: 'download'; version: string; bytes: number }
  | { step: 'restart'; version: string }
  | { step: 'health'; version: string }
  | { step: 'rollback'; version: string }
  | { step: 'provider' }
  | { step: 'selected'; version: string; installed: string }

export interface FetchContext {
  env: NodeJS.ProcessEnv
  platform: NodeJS.Platform
  arch?: string
  keys?: readonly HostReleaseKey[]
  progress?: (step: UpdateStep) => void
}

type Artifact = ReturnType<typeof verifyReleaseManifest>['artifacts'][number]

/** The signed release to move to: its version, this machine's artifact and any protocol notice. */
export async function fetchSignedRelease(
  context: FetchContext,
  requested: string | undefined,
  installed: string,
  signal: AbortSignal,
): Promise<{ version: string; artifact: Artifact; notice?: string }> {
  const keys = context.keys ?? HOST_RELEASE_KEYS
  if (!keys.length) throw new UpdateFailure('No Host release keys are pinned.', 69)
  context.progress?.({ step: 'check' })
  const tag = requested ? `host-v${requested}` : 'host-latest'
  const name = requested
    ? `phosphor-host-${requested}.manifest.json`
    : 'phosphor-host.manifest.json'
  const manifest = await downloadRelease(
    releaseUrl(context.env, tag, name),
    HOST_RELEASE_MANIFEST_MAX_BYTES,
    signal,
  )
  const signature = await downloadRelease(releaseUrl(context.env, tag, `${name}.sig`), 8192, signal)
  const signed = verifyReleaseManifest(manifest, signature.toString('utf8'), keys)
  const version = signed.version
  if (requested && version !== requested)
    throw new UpdateFailure('Release version does not match the request.', 64)
  if (compareVersions(version, installed) < 0) throw new UpdateFailure('refusing to downgrade', 64)
  const artifact = signed.artifacts.find(
    (a) => a.target === `${context.platform}-${context.arch ?? process.arch}`,
  )
  if (!artifact || !signed.protocols.some((p) => p >= HOST_PROTOCOL_VERSION))
    throw new UpdateFailure('Release does not support this Host.', 69)
  context.progress?.({ step: 'found', version, installed })
  // A newer protocol is how a Host catches up with updated apps; say so when it drops ours.
  const notice = signed.protocols.includes(HOST_PROTOCOL_VERSION)
    ? undefined
    : 'This release speaks a newer Host protocol: apps that have not updated cannot connect.'
  return { version, artifact, notice }
}

/** Download, verify and unpack the release into `stage`, an empty folder. */
/**
 * The verified release, decompressed. The compressed buffer is dropped on
 * return, before extraction: peak is compressed plus decompressed, each capped
 * at 256 MiB (512 MiB total, plus small verification buffers).
 */
async function downloadTar(
  context: FetchContext & { expandedCap?: number },
  version: string,
  artifact: Artifact,
  signal: AbortSignal,
): Promise<Buffer> {
  const bytes = await downloadRelease(
    releaseUrl(context.env, `host-v${version}`, artifact.file),
    artifact.bytes,
    signal,
  )
  verifyReleaseArtifact(bytes, artifact)
  return decompressRelease(bytes, context.expandedCap)
}

export async function stageRelease(
  context: FetchContext & { expandedCap?: number },
  stage: string,
  version: string,
  artifact: Artifact,
  signal: AbortSignal,
): Promise<void> {
  context.progress?.({ step: 'download', version, bytes: artifact.bytes })
  const tar = await downloadTar(context, version, artifact, signal)
  extractRelease(tar, stage, context.expandedCap)
  if (
    readBounded(join(stage, 'VERSION'), 32).replace(/\n+$/, '') !== version ||
    !['bin/phosphor', 'node/bin/node', 'lib/phosphor.mjs'].every((n) =>
      lstatSync(join(stage, n)).isFile(),
    )
  )
    throw new UpdateFailure('Invalid release bundle.')
}
