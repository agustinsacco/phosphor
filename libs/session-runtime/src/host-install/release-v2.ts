import {
  HOST_RELEASE_KEYS,
  type HostReleaseKey,
  type HostReleaseManifestV2,
} from '@phosphor/shared/host-release'
import { UpdateFailure } from './fetch'
import { fetchSignedManifest } from './signed-release'

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
  const found = await fetchSignedManifest({ env: source.env, keys }, signal)
  return found.manifest === 2 ? found : { manifest: 1, version: found.release.version }
}
