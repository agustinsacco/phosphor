/**
 * `artifact.remove` on the daemon (plan N7): This Mac's library delete, served
 * by the only artifact writer after migration. Desktop's rule holds: only a
 * conversation that is gone gives up its artifacts; a live lane's are part of
 * its history and go with the lane. The blobs are collected, so there is no Undo.
 */
import { join } from 'node:path'
import { isSessionId, readIndex } from '@phosphor/session-runtime/artifacts/artifact-indexer'
import { ArtifactLibrary } from '@phosphor/session-runtime/artifacts/artifact-library'
import { OpRefusal } from '@phosphor/session-runtime/ops/builtins'
import { op } from '@phosphor/session-runtime/ops/results'
import { artifactOwner } from './artifacts'
import type { DaemonHandlerDeps } from './index'

export const ARTIFACT_REMOVE_REFUSALS = {
  key: 'Name the artifact as <lane or session id>/<artifact id>.',
  live: 'That artifact belongs to a live lane; it goes with the lane.',
  missing: 'No artifact of a deleted conversation has that key.',
  unavailable: 'Artifacts are unavailable on this machine.',
} as const

/**
 * The session an artifact key names. `artifact.list` keys by lane id or, for a
 * conversation no lane holds, by pi session id. A live lane's is refused.
 */
function sessionOf(deps: DaemonHandlerDeps, prefix: string): string | null {
  const owner = artifactOwner(deps, prefix)
  if ('laneId' in owner) throw new OpRefusal('forbidden', ARTIFACT_REMOVE_REFUSALS.live)
  return owner.sessionId
}

export async function removeArtifact(deps: DaemonHandlerDeps, key: string) {
  if (!deps.stateDirectory) throw new OpRefusal('unavailable', ARTIFACT_REMOVE_REFUSALS.unavailable)
  const parts = key.split('/')
  if (parts.length !== 2 || !parts[0] || !parts[1] || !isSessionId(parts[0]))
    throw new OpRefusal('bad-request', ARTIFACT_REMOVE_REFUSALS.key)
  const sessionId = sessionOf(deps, parts[0])
  const root = join(deps.stateDirectory, 'artifacts')
  const index = sessionId && isSessionId(sessionId) ? readIndex(root, sessionId) : null
  if (!index) throw new OpRefusal('bad-request', ARTIFACT_REMOVE_REFUSALS.missing)
  const library = new ArtifactLibrary(() => root)
  // A gone file is marked deleted here; one still on disk is no deleted conversation.
  await library.indexFile(index.sessionFile)
  if (!(await library.remove(`${index.sessionId}/${parts[1]}`)))
    throw new OpRefusal('bad-request', ARTIFACT_REMOVE_REFUSALS.missing)
  return { text: `Removed artifact ${key}.`, undo: false as const }
}

export function artifactRemoveHandlers(deps: DaemonHandlerDeps) {
  return {
    'artifact.remove': op<{ key: string }>(({ key }) => removeArtifact(deps, key)),
  }
}
