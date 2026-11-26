import { parseRemoteLaneKey, remoteLaneKey } from '@phosphor/shared/remote-host'

/** `host:<self>/lane:<laneId>` for either of this machine's ids, or a bare lane id. */
export function laneIdOf(ref: string, selfIds: readonly string[]): string | null {
  const match = parseRemoteLaneKey(ref)
  if (!match) return ref
  return selfIds.includes(match.hostId) || (selfIds.length === 0 && match.hostId === 'local')
    ? match.laneId
    : null
}

/** The lane id in a ref this machine resolved (`LaneFacts.ref`, an agent's `laneRef`), or a bare id. */
export function laneIdInRef(ref: string): string {
  return parseRemoteLaneKey(ref)?.laneId ?? ref
}

/** The lane id of a resolved ref only: an op that needs a lane on this machine refuses a bare id. */
export const laneIdOfRef = (ref: string): string | undefined => parseRemoteLaneKey(ref)?.laneId

/** The ref this machine writes for its own lane: under the enrolled id when there is one. */
export function laneRefFor(selfIds: readonly string[], laneId: string): string {
  return remoteLaneKey(selfIds[0] ?? 'local', laneId)
}
