import { parseLaneMarksOp, type LaneMarksChange } from '@phosphor/shared/host-protocol-lane-marks'
import { HOST_TOO_OLD } from '@phosphor/shared/host-protocol-repositories'
import type { createHostConnection } from './connection'
import { REMOTE_UNAVAILABLE } from './lane-ops'

export const LANE_MARKS_UNCONFIRMED = 'The Host did not confirm the pin or marker change.'

type Connection = Pick<ReturnType<typeof createHostConnection>, 'snapshot' | 'incarnation' | 'send'>

/**
 * A Host lane's pin and marker, kept by the Host so every client shows the same ones.
 * Shared by Desktop and the browser. Unfenced: any client that may control lanes sets
 * them without taking control, on a live or stopped lane.
 */
export function laneMarks(connection: (hostId: string) => Connection | undefined) {
  return {
    async set(hostId: string, laneId: string, marks: LaneMarksChange): Promise<void> {
      const c = connection(hostId)
      if (!c) throw new Error(REMOTE_UNAVAILABLE)
      const generation = c.incarnation().generation
      // A reply from a replaced socket proves nothing about this Host.
      const available = () =>
        connection(hostId) === c &&
        c.incarnation().generation === generation &&
        c.snapshot().state === 'ready' &&
        c.snapshot().capabilities.includes('sessions.control')
      if (!available() || !c.snapshot().lanes.some((lane) => lane.laneId === laneId))
        throw new Error(REMOTE_UNAVAILABLE)
      const op = parseLaneMarksOp(
        typeof marks === 'object' && marks !== null ? { ...marks, type: 'lane.marks' } : null,
      )
      if (!op) throw new Error('Invalid lane pin or marker.')
      const result = await c.send(op, laneId)
      if (!available()) throw new Error(REMOTE_UNAVAILABLE)
      if (result.status === 'done') return
      throw new Error(
        result.status === 'rejected' && result.code === 'unsupported'
          ? HOST_TOO_OLD
          : LANE_MARKS_UNCONFIRMED,
      )
    },
  }
}
