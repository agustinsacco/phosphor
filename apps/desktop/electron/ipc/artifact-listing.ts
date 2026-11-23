import { remoteArtifactListings, type ArtifactHost } from '@phosphor/host-client/artifacts'
import { REMOTE_UNAVAILABLE } from '@phosphor/host-client/lane-ops'
import { artifactLibrary } from '../artifacts/artifact-sync'

export function libraryListing(key: unknown, hosts: ArtifactHost[], daemon: boolean) {
  if (
    !Array.isArray(key) ||
    key.length > 2000 ||
    key.some((p) => typeof p !== 'string' || p.startsWith('host:') || p.startsWith('remote-'))
  )
    throw new Error(REMOTE_UNAVAILABLE)
  if (daemon) return { result: remoteArtifactListings(hosts) }
  return {
    result: Promise.all([
      artifactLibrary.list(key),
      remoteArtifactListings(hosts).catch(() => []),
    ]).then(([local, remote]) => [...local, ...remote]),
  }
}
