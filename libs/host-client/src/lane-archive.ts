import {
  parseLaneArchiveList,
  parseLaneArchiveOp,
  type LaneArchiveOp,
} from '@phosphor/shared/lane-archive'
import { HOST_TOO_OLD } from '@phosphor/shared/host-protocol-repositories'
import type { createHostConnection } from './connection'
import { REMOTE_UNAVAILABLE } from './lane-ops'

type Connection = Pick<
  ReturnType<typeof createHostConnection>,
  'snapshot' | 'incarnation' | 'call' | 'send'
>
export function laneArchives(connection: (id: string) => Connection | undefined) {
  const admitted = (host: string, write: boolean) => {
    const c = connection(host)
    if (!c || c.snapshot().state !== 'ready') throw new Error(REMOTE_UNAVAILABLE)
    if (!c.snapshot().laneArchive) throw new Error(HOST_TOO_OLD)
    const generation = c.incarnation().generation
    const available = () =>
      connection(host) === c &&
      c.incarnation().generation === generation &&
      c.snapshot().state === 'ready' &&
      c.snapshot().capabilities.includes('sessions.read') &&
      (!write ||
        (c.snapshot().capabilities.includes('sessions.control') &&
          c.snapshot().capabilities.includes('workspaces.write')))
    if (!available()) throw new Error(REMOTE_UNAVAILABLE)
    return { c, available }
  }
  const command = async (host: string, op: LaneArchiveOp): Promise<void> => {
    if (!parseLaneArchiveOp(op)) throw new Error('Invalid archive operation.')
    const { c, available } = admitted(host, true)
    const lane =
      op.type === 'lane.archive'
        ? c.snapshot().lanes.find((lane) => lane.laneId === op.laneId)
        : undefined
    if (op.type === 'lane.archive' && !lane) throw new Error('This lane is no longer available.')
    const reply = await c.send(op, lane?.laneId, lane?.control.fence)
    if (!available()) throw new Error(REMOTE_UNAVAILABLE)
    if (reply.status !== 'done')
      throw new Error(
        reply.status === 'rejected' && reply.code === 'unsupported'
          ? HOST_TOO_OLD
          : 'The Host did not confirm the archive operation. Check Archive before retrying; unfinished work stays there.',
      )
  }
  return {
    async list(host: string, measure = false) {
      const { c, available } = admitted(host, false)
      const reply = await c.call('archive.list', { measure })
      if (!available() || !reply.ok) throw new Error(REMOTE_UNAVAILABLE)
      const result = parseLaneArchiveList(reply.data)
      if (!result) throw new Error('Invalid archive listing from Host.')
      return result
    },
    archive: (host: string, laneId: string) => command(host, { type: 'lane.archive', laneId }),
    restore: (host: string, archiveId: string) =>
      command(host, { type: 'archive.restore', archiveId }),
    purge: (host: string, archiveId: string, removeWorktree: boolean) =>
      command(host, { type: 'archive.purge', archiveId, removeWorktree }),
  }
}
