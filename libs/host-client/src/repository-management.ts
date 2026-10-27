import { parseClientFrame, type LaneOp } from '@phosphor/shared/host-protocol'
import {
  parseFolderParams,
  parseFolderList,
  parseDeleteLaneResult,
  isRepositoryId,
  FOLDER_EXISTS,
  HOST_TOO_OLD,
} from '@phosphor/shared/host-protocol-repositories'
import type { createHostConnection } from './connection'
import { REMOTE_UNAVAILABLE } from './lane-ops'
/** Only for shape validation: the connection mints each frame's real request id. */
const PROBE_REQUEST = '00000000-0000-4000-8000-000000000000'

type Connection = Pick<
  ReturnType<typeof createHostConnection>,
  'snapshot' | 'incarnation' | 'call' | 'send'
>

/**
 * The Host's connection, if it is ready and may write workspaces, with a check that it still is
 * the same connection once a reply arrives: a reply from a replaced socket proves nothing.
 */
function admit(
  connection: (hostId: string) => Connection | undefined,
  hostId: string,
  control: boolean,
) {
  const c = connection(hostId)
  if (!c) throw new Error(REMOTE_UNAVAILABLE)
  const generation = c.incarnation().generation
  const available = () =>
    connection(hostId) === c &&
    c.incarnation().generation === generation &&
    c.snapshot().state === 'ready' &&
    c.snapshot().capabilities.includes('workspaces.write') &&
    (!control || c.snapshot().capabilities.includes('sessions.control'))
  if (!available()) throw new Error(REMOTE_UNAVAILABLE)
  return { c, available }
}

function refusal(code: string | undefined, op: LaneOp): string {
  return code === 'last-repository'
    ? 'A machine needs at least one folder. Add another first.'
    : code === 'conflict' && op.type === 'host.repositories.createFolder'
      ? FOLDER_EXISTS
      : code === 'unsupported'
        ? HOST_TOO_OLD
        : 'The remote change was not confirmed.'
}

/** Folder browsing and repository changes on a Host, shared by Desktop and the browser. */
export function repositoryManagement(connection: (hostId: string) => Connection | undefined) {
  const admitted = (hostId: string, control: boolean) => admit(connection, hostId, control)
  async function command(hostId: string, op: LaneOp, laneId?: string) {
    const { c, available } = admitted(hostId, true)
    const fence = laneId
      ? c.snapshot().lanes.find((l) => l.laneId === laneId)?.control.fence
      : undefined
    if (laneId && fence === undefined) throw new Error(REMOTE_UNAVAILABLE)
    if (
      !parseClientFrame(
        JSON.stringify({ type: 'command', requestId: PROBE_REQUEST, op, laneId, fence }),
      ).ok
    )
      throw new Error(REMOTE_UNAVAILABLE)
    const result = await c.send(op, laneId, fence)
    if (!available()) throw new Error(REMOTE_UNAVAILABLE)
    if (result.status !== 'done')
      throw new Error(refusal(result.status === 'rejected' ? result.code : undefined, op))
    return result.data
  }
  return {
    async folders(hostId: string, path?: string, hidden?: boolean) {
      const { c, available } = admitted(hostId, false)
      // `hidden` is sent only when asked for: older Hosts refuse the key.
      const params = parseFolderParams({
        ...(path === undefined ? {} : { path }),
        ...(hidden ? { hidden: true } : {}),
      })
      if (!params) throw new Error(REMOTE_UNAVAILABLE)
      const reply = await c.call('machine.folders.list', params)
      if (!available() || !reply.ok) throw new Error(REMOTE_UNAVAILABLE)
      const result = parseFolderList(reply.data)
      if (!result) throw new Error(REMOTE_UNAVAILABLE)
      return result
    },
    async add(hostId: string, path: string) {
      const result = await command(hostId, { type: 'host.repositories.add', path })
      if (
        typeof result !== 'object' ||
        result === null ||
        !('id' in result) ||
        !isRepositoryId(result.id)
      )
        throw new Error(REMOTE_UNAVAILABLE)
      return { repositoryId: result.id }
    },
    async createFolder(hostId: string, path: string) {
      await command(hostId, { type: 'host.repositories.createFolder', path })
    },
    async remove(hostId: string, repositoryId: string) {
      await command(hostId, { type: 'host.repositories.remove', repositoryId })
    },
    async order(hostId: string, repositoryIds: string[]) {
      await command(hostId, { type: 'host.repositories.order', repositoryIds })
    },
    async deleteLane(
      hostId: string,
      laneId: string,
      options: { removeWorktree: boolean; removeBranch: boolean },
    ) {
      const result = parseDeleteLaneResult(
        await command(hostId, { type: 'lane.delete', laneId, ...options }, laneId),
      )
      if (!result) throw new Error('Remote deletion outcome is unknown.')
      return result
    },
  }
}
