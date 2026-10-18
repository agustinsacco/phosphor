import type { Routine, RoutineRun, RoutinesSnapshot } from '@phosphor/shared/routines'
import {
  parseRoutineList,
  parseRoutineReceiptData,
  parseRoutineHistory,
  parseRoutineOp,
  parseRoutineParams,
  routineRequiresControl,
} from '@phosphor/shared/host-protocol-routines'
import {
  ROUTINE_UNKNOWN,
  UNAVAILABLE,
  routineKey,
  cacheDefinitions,
  type Connection,
  type RemoteRoutinePorts,
  type RemoteRoutineState,
} from './state'

export function admitted(
  ports: RemoteRoutinePorts,
  host: string,
  control = false,
  expected?: Connection,
  incarnation?: string,
): Connection {
  const connection = ports.connection(host)
  const view = connection?.snapshot()
  if (
    !connection ||
    (expected && connection !== expected) ||
    (incarnation !== undefined && view?.connectionToken !== incarnation) ||
    view?.state !== 'ready' ||
    !view.capabilities.includes('routines') ||
    (control && !view.capabilities.includes('sessions.control'))
  )
    throw new Error(UNAVAILABLE)
  return connection
}
export function mapRoutine(
  ports: RemoteRoutinePorts,
  host: string,
  r: NonNullable<ReturnType<typeof parseRoutineList>>[number],
): Routine {
  const view = admitted(ports, host).snapshot()
  const repository = view.repositories.find((entry) => entry.id === r.repositoryId)
  if (!repository) throw new Error(UNAVAILABLE)
  const { repositoryId, ...config } = r
  return {
    ...config,
    id: routineKey(host, r.id),
    workspacePath: repository.name,
    attention: null,
    machine: {
      id: `host:${host}`,
      label: ports.label(host),
      repositoryId,
      control: view.capabilities.includes('sessions.control'),
    },
  }
}
export async function query(
  ports: RemoteRoutinePorts,
  host: string,
  method: string,
  params: unknown,
): Promise<unknown> {
  const connection = admitted(ports, host)
  const incarnation = connection.snapshot().connectionToken
  if (!parseRoutineParams(method, params)) throw new Error(UNAVAILABLE)
  let result
  try {
    result = await connection.call(method, params)
  } catch {
    throw new Error(UNAVAILABLE)
  }
  admitted(ports, host, false, connection, incarnation)
  if (!result.ok) throw new Error(UNAVAILABLE)
  return result.data
}
export async function list(
  state: RemoteRoutineState,
  ports: RemoteRoutinePorts,
  host: string,
): Promise<RoutinesSnapshot> {
  const connection = admitted(ports, host)
  const incarnation = connection.snapshot().connectionToken
  const rows = parseRoutineList(await query(ports, host, 'routines.list', {}))
  admitted(ports, host, false, connection, incarnation)
  if (!rows) throw new Error(UNAVAILABLE)
  const routines = rows.map((r) => mapRoutine(ports, host, r))
  cacheDefinitions(state, host, routines)
  return { routines, runs: [], background: false, error: null }
}
export async function history(
  state: RemoteRoutineState,
  ports: RemoteRoutinePorts,
  host: string,
  id: string,
  offset: unknown,
): Promise<RoutineRun[]> {
  const connection = admitted(ports, host)
  const incarnation = connection.snapshot().connectionToken
  const rows = parseRoutineHistory(
    await query(ports, host, 'routines.history', { routineId: id, offset }),
  )
  admitted(ports, host, false, connection, incarnation)
  if (!rows || rows.some((r) => r.routineId !== id)) throw new Error(UNAVAILABLE)
  const snapshot = await list(state, ports, host)
  admitted(ports, host, false, connection, incarnation)
  const definition = snapshot.routines.find((r) => r.id === routineKey(host, id))
  if (!definition) throw new Error(UNAVAILABLE)
  return rows.map((r) => runRecord(host, r, definition))
}
export function runRecord(
  host: string,
  r: NonNullable<ReturnType<typeof parseRoutineHistory>>[number],
  definition: Routine,
): RoutineRun {
  return {
    ...r,
    id: routineKey(host, r.id),
    routineId: routineKey(host, r.routineId),
    definition,
    trigger: 'schedule',
    createdAt: r.scheduledAt,
    reason: '',
    summary: '',
    sessionId: null,
    sessionPath: null,
    workspacePath: null,
    branch: null,
    baseCommit: null,
    accountId: null,
  }
}
export async function run(
  state: RemoteRoutineState,
  ports: RemoteRoutinePorts,
  host: string,
  id: string,
): Promise<RoutineRun> {
  const connection = admitted(ports, host, true)
  const incarnation = connection.snapshot().connectionToken
  const definition = state.definitions.get(host)?.find((r) => r.id === routineKey(host, id))
  if (!definition) throw new Error(UNAVAILABLE)
  const runId = await mutate(state, ports, host, { type: 'routine.run', routineId: id })
  admitted(ports, host, true, connection, incarnation)
  if (!runId) throw new Error(UNAVAILABLE)
  let rows: ReturnType<typeof parseRoutineHistory> = null
  try {
    rows = parseRoutineHistory(
      await query(ports, host, 'routines.history', { routineId: id, offset: 0 }),
    )
  } catch {
    /* The confirmed run is not retried when its history is unavailable. */
  }
  admitted(ports, host, true, connection, incarnation)
  const found = rows?.find((r) => r.id === runId && r.routineId === id)
  const now = Date.now()
  return {
    ...runRecord(
      host,
      found ?? {
        id: runId,
        routineId: id,
        status: 'queued',
        scheduledAt: now,
        startedAt: null,
        endedAt: null,
      },
      definition,
    ),
    trigger: 'manual',
  }
}

export async function mutate(
  state: RemoteRoutineState,
  ports: RemoteRoutinePorts,
  host: string,
  raw: unknown,
): Promise<string | undefined> {
  if (state.uncertain.has(host)) throw new Error(ROUTINE_UNKNOWN)
  const op = parseRoutineOp(raw)
  if (!op) throw new Error(UNAVAILABLE)
  const control = routineRequiresControl(op)
  const connection = admitted(ports, host, control)
  const incarnation = connection.snapshot().connectionToken
  if (
    op.type === 'routine.save' &&
    !connection.snapshot().repositories.some((r) => r.id === op.routine.repositoryId)
  )
    throw new Error(UNAVAILABLE)
  let result
  try {
    result = await connection.send(op)
  } catch {
    admitted(ports, host, control, connection, incarnation)
    state.uncertain.add(host)
    throw new Error(ROUTINE_UNKNOWN)
  }
  admitted(ports, host, control, connection, incarnation)
  if (result.status === 'unknown' || result.status === 'pending') {
    state.uncertain.add(host)
    throw new Error(ROUTINE_UNKNOWN)
  }
  admitted(ports, host, control, connection, incarnation)
  if (result.status === 'done' && !parseRoutineReceiptData(op, result.data)) {
    state.uncertain.add(host)
    throw new Error(UNAVAILABLE)
  }
  if (result.status !== 'done')
    throw new Error('Routine operation was not completed. Refresh before taking another action.')
  if (
    op.type === 'routine.run' &&
    result.status === 'done' &&
    result.data &&
    typeof result.data === 'object' &&
    'runId' in result.data &&
    typeof result.data.runId === 'string'
  )
    return result.data.runId
  return undefined
}
