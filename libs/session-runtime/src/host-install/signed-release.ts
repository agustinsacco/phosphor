import {
  HOST_RELEASE_MANIFEST_MAX_BYTES,
  HOST_RELEASE_MANIFEST_V2,
  hostReleaseManifestV2Name,
  type HostReleaseKey,
  type HostReleaseManifest,
  type HostReleaseManifestV2,
} from '@phosphor/shared/host-release'
import { ReleaseNotFound, downloadRelease, releaseUrl } from './download'
import { verifyReleaseManifest, verifyReleaseManifestV2 } from './verify'

/** Where a release's manifests are: `host-latest`, or `host-v<version>` for a requested one. */
export interface SignedReleaseSource {
  env: NodeJS.ProcessEnv
  keys: readonly HostReleaseKey[]
  /** A requested version; omitted for `host-latest`. */
  requested?: string
}

/** The signed release on a tag: v2 when it is published there, else v1. */
export type SignedRelease =
  { manifest: 2; release: HostReleaseManifestV2 } | { manifest: 1; release: HostReleaseManifest }

async function signedManifest<T>(
  source: SignedReleaseSource,
  name: string,
  verify: (bytes: Buffer, signature: string, keys: readonly HostReleaseKey[]) => T,
  signal: AbortSignal,
): Promise<T> {
  const tag = source.requested ? `host-v${source.requested}` : 'host-latest'
  const url = (file: string) => releaseUrl(source.env, tag, file)
  const bytes = await downloadRelease(url(name), HOST_RELEASE_MANIFEST_MAX_BYTES, signal)
  const signature = await downloadRelease(url(`${name}.sig`), 8192, signal).catch(
    (error: unknown) => {
      // A manifest without its signature is a broken release, never an absent one.
      throw error instanceof ReleaseNotFound
        ? new Error(`${name} has no signature.`, { cause: error })
        : error
    },
  )
  return verify(bytes, signature.toString('utf8'), source.keys)
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
 * The signed release on the source's tag. Falls back to v1 only when the v2
 * manifest is absent (404 or a missing file). A v2 that exists but fails its
 * signature, its parser or the v1 cross-check, and any network failure, throws.
 */
export async function fetchSignedManifest(
  source: SignedReleaseSource,
  signal: AbortSignal,
): Promise<SignedRelease> {
  const v1Name = source.requested
    ? `phosphor-host-${source.requested}.manifest.json`
    : 'phosphor-host.manifest.json'
  const v2Name = source.requested
    ? hostReleaseManifestV2Name(source.requested)
    : HOST_RELEASE_MANIFEST_V2
  let release: HostReleaseManifestV2
  try {
    release = await signedManifest(source, v2Name, verifyReleaseManifestV2, signal)
  } catch (error) {
    if (!(error instanceof ReleaseNotFound)) throw error
    return {
      manifest: 1,
      release: await signedManifest(source, v1Name, verifyReleaseManifest, signal),
    }
  }
  const v1 = await signedManifest(source, v1Name, verifyReleaseManifest, signal).catch(
    (error: unknown) => {
      throw error instanceof ReleaseNotFound
        ? new Error('The v2 release has no v1 manifest beside it.', { cause: error })
        : error
    },
  )
  if (!sameRelease(v1, release)) throw new Error('The v1 and v2 release manifests disagree.')
  return { manifest: 2, release }
}
