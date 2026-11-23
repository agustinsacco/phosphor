import type { HostReleaseManifest, HostReleaseManifestV2 } from '@phosphor/shared/host-release'
import type { BundleVersion } from './probe'

/** D4 supplies the signature-verified manifest; never use unverified release metadata here. */
export function requireLocalRelease(
  manifest: HostReleaseManifest | HostReleaseManifestV2,
  bundle: BundleVersion,
  target: string,
) {
  if (
    manifest.schema !== 2 ||
    manifest.version !== bundle.hostVersion ||
    !manifest.protocols.includes(bundle.protocolVersion) ||
    !['local-mode', 'owner-socket'].every(
      (name) => manifest.features.includes(name) && bundle.features.includes(name),
    )
  )
    throw new Error('This release does not support the local Phosphor service.')
  const artifact = manifest.artifacts.find((artifact) => artifact.target === target)
  if (!artifact) throw new Error('No local Phosphor service release for this machine.')
  return artifact
}
