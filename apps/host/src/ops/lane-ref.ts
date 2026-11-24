import { remoteLaneKey } from '@phosphor/shared/remote-host'

/** `host:<machine>/lane:<laneId>`: the one shape of a lane ref (`remoteLaneKey`). */
const LANE_REF = /^host:([^/]+)\/lane:([^/]+)$/

/** `host:<self>/lane:<laneId>` for either of this machine's ids, or a bare lane id. */
export function laneIdOf(ref: string, selfIds: readonly string[]): string | null {
  const match = LANE_REF.exec(ref)
  if (!match) return ref
  return selfIds.includes(match[1]!) || (selfIds.length === 0 && match[1] === 'local')
    ? match[2]!
    : null
}

/** The lane id in a ref this machine resolved (`LaneFacts.ref`, an agent's `laneRef`), or a bare id. */
export function laneIdInRef(ref: string): string {
  return LANE_REF.exec(ref)?.[2] ?? ref
}

/** The lane id of a resolved ref only: an op that needs a lane on this machine refuses a bare id. */
export const laneIdOfRef = (ref: string): string | undefined => LANE_REF.exec(ref)?.[2]

/** The ref this machine writes for its own lane: under the enrolled id when there is one. */
export function laneRefFor(selfIds: readonly string[], laneId: string): string {
  return remoteLaneKey(selfIds[0] ?? 'local', laneId)
}
