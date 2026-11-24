import {
  HOST_RELEASE_KEYS,
  HOST_RELEASE_MANIFEST_MAX_BYTES,
  HOST_RELEASE_MANIFEST_V2,
  type HostReleaseKey,
  type HostReleaseManifest,
  type HostReleaseManifestV2,
} from '@phosphor/shared/host-release'
import { ReleaseNotFound, downloadRelease, releaseUrl } from './download'
import { UpdateFailure } from './fetch'
import { verifyReleaseManifest, verifyReleaseManifestV2 } from './verify'

const MANIFEST_V1 = 'phosphor-host.manifest.json'

export interface LocalReleaseSource {
  env: NodeJS.ProcessEnv
  keys?: readonly HostReleaseKey[]
}

/**
 * What `host-latest` publishes. `manifest: 1` means no v2 manifest exists yet
 * (an older Host release): the caller keeps the in-app runtime and checks again later.
 */
export type LocalReleaseCheck =
  { manifest: 2; release: HostReleaseManifestV2 } | { manifest: 1; version: string }

async function signedManifest<T>(
  source: LocalReleaseSource,
  name: string,
  keys: readonly HostReleaseKey[],
  verify: (bytes: Buffer, signature: string, keys: readonly HostReleaseKey[]) => T,
  signal: AbortSignal,
): Promise<T> {
  const url = (file: string) => releaseUrl(source.env, 'host-latest', file)
  const bytes = await downloadRelease(url(name), HOST_RELEASE_MANIFEST_MAX_BYTES, signal)
  const signature = await downloadRelease(url(`${name}.sig`), 8192, signal).catch(
    (error: unknown) => {
      // A manifest without its signature is a broken release, never an absent one.
      throw error instanceof ReleaseNotFound
        ? new Error(`${name} has no signature.`, { cause: error })
        : error
    },
  )
  return verify(bytes, signature.toString('utf8'), keys)
}

/** v2 must agree with the v1 manifest published beside it on every field they share. */
function sameRelease(v1: HostReleaseManifest, v2: HostReleaseManifestV2): boolean {
  return (
    v1.version === v2.version &&
    v1.node === v2.node &&
    v1.sourceCommit === v2.sourceCommit &&
    v1.protocols.length === v2.protocols.length &&
    v1.protocols.every((p, i) => v2.protocols[i] === p) &&
    v1.artifacts.every((a) =>
      v2.artifacts.some(
        (b) =>
          b.target === a.target &&
          b.file === a.file &&
          b.bytes === a.bytes &&
          b.sha256 === a.sha256,
      ),
    )
  )
}

/**
 * The signed release a local service would install, from `host-latest`. Falls
 * back to v1 only when the v2 manifest is absent (404 or a missing file). A v2
 * that exists but fails its signature, its parser or the v1 cross-check, and
 * any network failure, throws: nothing is installed and the caller retries later.
 */
export async function fetchLocalRelease(
  source: LocalReleaseSource,
  signal: AbortSignal,
): Promise<LocalReleaseCheck> {
  const keys = source.keys ?? HOST_RELEASE_KEYS
  if (!keys.length) throw new UpdateFailure('No Host release keys are pinned.', 69)
  let release: HostReleaseManifestV2
  try {
    release = await signedManifest(
      source,
      HOST_RELEASE_MANIFEST_V2,
      keys,
      verifyReleaseManifestV2,
      signal,
    )
  } catch (error) {
    if (!(error instanceof ReleaseNotFound)) throw error
    const v1 = await signedManifest(source, MANIFEST_V1, keys, verifyReleaseManifest, signal)
    return { manifest: 1, version: v1.version }
  }
  const v1 = await signedManifest(source, MANIFEST_V1, keys, verifyReleaseManifest, signal).catch(
    (error: unknown) => {
      throw error instanceof ReleaseNotFound
        ? new Error('The v2 release has no v1 manifest beside it.', { cause: error })
        : error
    },
  )
  if (!sameRelease(v1, release)) throw new Error('The v1 and v2 release manifests disagree.')
  return { manifest: 2, release }
}
