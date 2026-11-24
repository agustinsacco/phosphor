import { OpRefusal } from '@phosphor/session-runtime/ops/builtins'
import { op, dataResult, pageOffset } from '@phosphor/session-runtime/ops/results'
import { OPS_LIMITS } from '@phosphor/shared/host-protocol-ops'
import {
  isArchiveId,
  parseLaneArchiveList,
  type LaneArchiveOp,
} from '@phosphor/shared/lane-archive'
import type { OpHandlerContext } from '@phosphor/session-runtime/ops/types'
import { laneCall } from './lane-ports'
import { laneChange } from './lane-undo'
import type { DaemonHandlerDeps } from './index'

async function inventory(deps: DaemonHandlerDeps, measure: boolean) {
  const result = await deps.lanes.calls.call('archive.list', { measure })
  const list = result.ok && parseLaneArchiveList(result.data)
  if (!list) throw new OpRefusal('unavailable', 'The archive inventory is unavailable.')
  return list
}
/** Resolve all before both confirmation and redemption; a changed selection cannot redeem. */
export async function archiveSelection(deps: DaemonHandlerDeps) {
  const list = await inventory(deps, false)
  if (list.truncated || list.entries.length > OPS_LIMITS.idsPerOp)
    throw new OpRefusal('too-large', 'Select fewer archives by id.')
  if (!list.entries.length) throw new OpRefusal('bad-request', 'There are no archives to purge.')
  return list.entries.map((a) => a.id).sort()
}
export async function archiveCommand(
  deps: DaemonHandlerDeps,
  action: LaneArchiveOp,
  allowed: () => boolean,
) {
  const archives = deps.management?.archives
  if (!archives) throw new OpRefusal('unsupported', 'Archive service unavailable.')
  const result = await archives.execute(action, allowed)
  if (!result.ok)
    throw new OpRefusal(
      result.code === 'busy' || result.code === 'forbidden' ? result.code : 'bad-request',
      `${action.type} refused: ${result.code}.`,
    )
}
export function archiveHandlers(deps: DaemonHandlerDeps) {
  return {
    'archive.list': op<{ measure?: boolean }>(async ({ measure = false }, c) => {
      const list = parseLaneArchiveList(await laneCall(deps, 'archive.list', { measure }, c))
      if (!list) throw new OpRefusal('unavailable', 'Invalid archive inventory.')
      const start = pageOffset(c),
        entries = list.entries.slice(start, start + 50),
        end = start + entries.length
      return {
        ...dataResult({ ...list, entries }),
        ...(end < list.entries.length ? { next: String(end) } : {}),
      }
    }),
    'archive.restore': op<{ id: string }>(async ({ id }, c) => {
      if (!isArchiveId(id)) throw new OpRefusal('bad-request', 'Invalid archive id.')
      await archiveCommand(
        deps,
        { type: 'archive.restore', archiveId: id },
        () => !c.signal.aborted,
      )
      return laneChange(deps, id, `Restored ${id}.`, { ref: id })
    }),
    'archive.purge': op<{ ids: string[]; removeWorktree?: boolean }>(
      async ({ ids, removeWorktree = false }, c: OpHandlerContext) => {
        if (!ids?.length || !ids.every(isArchiveId))
          throw new OpRefusal('bad-request', 'Select valid archive ids.')
        const purged: string[] = []
        for (const id of ids) {
          try {
            await archiveCommand(
              deps,
              { type: 'archive.purge', archiveId: id, removeWorktree },
              () => !c.signal.aborted,
            )
          } catch (error) {
            throw new Error(
              `Purged ${purged.length} of ${ids.length}; stopped at ${id}: ${String(error)}`,
              { cause: error },
            )
          }
          purged.push(id)
        }
        return { text: `Purged ${purged.length} archives.`, data: { purged } }
      },
    ),
  }
}
