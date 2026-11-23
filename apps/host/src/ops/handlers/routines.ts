import { laneRefFor } from '../binding'
import { parseRoutineHistory } from '@phosphor/shared/host-protocol-routines'
import { randomUUID } from 'node:crypto'
import { OpRefusal } from '@phosphor/session-runtime/ops/builtins'
import { dataResult, op, pageRows } from '@phosphor/session-runtime/ops/results'
import type { OpHandler } from '@phosphor/session-runtime/ops/types'
import type { UndoPorts } from '@phosphor/session-runtime/ops/undo'
import {
  parseRoutineList,
  type RemoteRoutine,
  type RemoteRoutineInput,
  type RoutineOp,
} from '@phosphor/shared/host-protocol-routines'
import type { DaemonHandlerDeps } from './index'
import { NO_CONTENT_UNDO, resourceCall } from './resources-call'

type Definition = Omit<RemoteRoutineInput, 'enabled' | 'trusted'>
type Edit = { id: string; revision: number; patch: Partial<Definition> }
type ById = { id: string }
const acknowledgement = 'Open Routines and acknowledge unattended access first.'

async function current(deps: DaemonHandlerDeps, id: string) {
  const row = parseRoutineList(await resourceCall(deps, 'routines.list', {}))?.find(
    (r) => r.id === id,
  )
  if (!row || row.archived) throw new OpRefusal('bad-request', 'Routine is unavailable.')
  return row
}
function definition(row: RemoteRoutine): RemoteRoutineInput {
  const {
    id: _id,
    revision: _revision,
    createdAt: _createdAt,
    updatedAt: _updatedAt,
    nextAt: _nextAt,
    archived: _archived,
    ...input
  } = row
  return input
}
function execute(deps: DaemonHandlerDeps, operation: RoutineOp) {
  if (!deps.routines) throw new OpRefusal('unavailable', 'Routines unavailable.')
  // The dispatcher admitted this specific catalog op. Only the owner constructs a save.
  return deps.routines.execute(operation, randomUUID(), ['routines', 'sessions.control'])
}
async function edit(deps: DaemonHandlerDeps, { id, revision, patch }: Edit) {
  const row = await current(deps, id)
  if (row.revision !== revision)
    throw new OpRefusal('bad-request', 'The routine has changed. Read it again.')
  // Only the display name is cosmetic. Even an edit by a surface cannot acknowledge trust here.
  const trusted = row.trusted && Object.keys(patch).every((key) => key === 'name')
  const data = await execute(deps, {
    type: 'routine.save',
    routineId: id,
    expectedRevision: revision,
    routine: { ...definition(row), ...patch, trusted, enabled: trusted && row.enabled },
  })
  return { text: `Updated routine. ${NO_CONTENT_UNDO}`, data }
}
function toggle(deps: DaemonHandlerDeps, enabled: boolean) {
  return op<ById>(async ({ id }) => {
    const row = await current(deps, id)
    if (enabled && !row.trusted) throw new OpRefusal('forbidden', acknowledgement)
    if (row.enabled === enabled)
      throw new OpRefusal('bad-request', `Routine is already ${enabled ? 'enabled' : 'paused'}.`)
    const data = await execute(deps, {
      type: 'routine.save',
      routineId: id,
      expectedRevision: row.revision,
      routine: { ...definition(row), enabled },
    })
    return { ...dataResult(data), before: { id } }
  })
}
export async function routineUndoCurrent(
  deps: DaemonHandlerDeps,
  entry: Parameters<UndoPorts['isCurrent']>[0],
) {
  const id = entry.undoRecord.inverse.args.id
  if (typeof id !== 'string') return false
  const row = await current(deps, id)
  if (entry.op === 'routine.create') return row.revision === 1 && !row.enabled && !row.trusted
  return (
    row.trusted &&
    ((entry.op === 'routine.enable' && row.enabled) ||
      (entry.op === 'routine.disable' && !row.enabled))
  )
}
export function routineHandlers(deps: DaemonHandlerDeps): Readonly<Record<string, OpHandler>> {
  const runs = op<{ id?: string; offset?: number }>(async ({ id, offset = 0 }) => {
    const rows = parseRoutineHistory(
      await resourceCall(
        deps,
        id ? 'routines.history' : 'routines.activity',
        id ? { routineId: id, offset } : { offset },
      ),
    )
    if (!rows) throw new OpRefusal('unavailable', 'Routine activity is unavailable.')
    const refs = new Map(
      deps.store
        .listLanes()
        .filter((l) => l.sessionFile && !l.removedAt)
        .map((l) => [l.sessionFile, laneRefFor(deps.selfIds(), l.laneId)]),
    )
    return dataResult(
      rows.map((row) => {
        const path = deps.routines?.sessionPathForRun?.(row.id)
        const laneRef = path && refs.get(path)
        return laneRef ? { ...row, laneRef } : row
      }),
    )
  })
  return {
    'routine.list': op(async (_, ctx) =>
      pageRows(parseRoutineList(await resourceCall(deps, 'routines.list', {})) ?? [], ctx),
    ),
    'routine.history': runs,
    'routine.activity': runs,
    'routine.create': op<{ definition: Definition }>(async ({ definition }) => {
      const data = await execute(deps, {
        type: 'routine.save',
        expectedRevision: null,
        routine: { ...definition, enabled: false, trusted: false },
      })
      return {
        ...dataResult(data),
        ...('routineId' in data ? { before: { id: data.routineId } } : {}),
      }
    }),
    'routine.edit': op<Edit>((a) => edit(deps, a)),
    'routine.enable': toggle(deps, true),
    'routine.disable': toggle(deps, false),
    'routine.run': op<ById>(async ({ id }) => {
      if (!(await current(deps, id)).trusted) throw new OpRefusal('forbidden', acknowledgement)
      return dataResult(await execute(deps, { type: 'routine.run', routineId: id }))
    }),
    'routine.cancel': op<{ runId: string }>(async ({ runId }) =>
      dataResult(await execute(deps, { type: 'routine.cancel', runId })),
    ),
    'routine.pauseAll': op(async () =>
      dataResult(await execute(deps, { type: 'routine.pauseAll' })),
    ),
    ...Object.fromEntries(
      (['routine.skipNext', 'routine.archive', 'routine.delete'] as const).map((type) => [
        type,
        op<ById>(async ({ id }) => dataResult(await execute(deps, { type, routineId: id }))),
      ]),
    ),
  }
}
