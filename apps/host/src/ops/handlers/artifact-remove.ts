/**
 * `artifact.remove` on the daemon (plan N7): This Mac's library delete, served
 * by the only artifact writer after migration. Desktop's rule holds: only a
 * conversation that is gone gives up its artifacts; a live lane's are part of
 * its history and go with the lane. The blobs are collected, so there is no Undo.
 */
import { removeDeletedArtifact } from '../../features/artifacts/remove'
import { op } from '@phosphor/session-runtime/ops/results'
import { artifactOwner } from './artifacts'
import type { DaemonHandlerDeps } from './index'
export { ARTIFACT_REMOVE_REFUSALS } from '../../features/artifacts/remove'

export function removeArtifact(deps: DaemonHandlerDeps, key: string) {
  return removeDeletedArtifact(
    deps.stateDirectory,
    (prefix) => artifactOwner(deps, prefix),
    key,
    deps.lanes?.lanesTopic,
  )
}

export function artifactRemoveHandlers(deps: DaemonHandlerDeps) {
  return {
    'artifact.remove': op<{ key: string }>(({ key }) => removeArtifact(deps, key)),
  }
}
