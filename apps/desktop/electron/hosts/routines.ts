import type { IpcInvokeChannel } from '@shared/ipc'
import type { Routine, RoutineMachine, RoutineRun, RoutinesSnapshot } from '@shared/routines'
import {
  parseRoutineList,
  parseRoutineReceiptData,
  parseRoutineHistory,
  parseRoutineOp,
  parseRoutineParams,
  routineRequiresControl,
  type RoutineOp,
} from '@shared/host-protocol-routines'
import type { createHostConnection } from './connection'

export const ROUTINE_UNKNOWN = 'The outcome is unknown. Refresh before taking another action.'
const UNAVAILABLE = 'Machine routines are unavailable.'
type Connection = Pick<ReturnType<typeof createHostConnection>, 'snapshot' | 'call' | 'send'>
const key = (host: string, id: string): string => `host:${host}/${id}`
const target = (value: unknown): { host: string; id?: string } | null => {
  if (typeof value !== 'string') return null
  const match = /^host:([0-9a-f-]{36})(?:\/([0-9a-f-]{36}))?$/i.exec(value)
  return match?.[1] ? { host: match[1], id: match[2] } : null
}

/** Machine operations deliberately have no lane or fence. No errors from the Host cross IPC. */
export function createRemoteRoutines(ports: {
  connection(host: string): Connection | undefined
  hosts(): string[]
  view?(
    host: string,
  ): Pick<ReturnType<Connection['snapshot']>, 'state' | 'capabilities' | 'repositories'> | undefined
  label(host: string): string
}) {
  const uncertain = new Set<string>()
  const definitions = new Map<string, Routine[]>()
  function admitted(host: string, control = false, expected?: Connection): Connection {
    const connection = ports.connection(host)
    const view = connection?.snapshot()
    if (
      !connection ||
      (expected && connection !== expected) ||
      view?.state !== 'ready' ||
      !view.capabilities.includes('routines') ||
      (control && !view.capabilities.includes('sessions.control'))
    )
      throw new Error(UNAVAILABLE)
    return connection
  }
  function machines(): RoutineMachine[] {
    const hosts = ports.hosts()
    for (const host of definitions.keys()) if (!hosts.includes(host)) definitions.delete(host)
    for (const host of uncertain) if (!hosts.includes(host)) uncertain.delete(host)
    return hosts.flatMap((host) => {
      const view = ports.view?.(host) ?? ports.connection(host)?.snapshot()
      if (!view?.capabilities.includes('routines')) return []
      return [
        {
          id: `host:${host}`,
          label: ports.label(host),
          available: view.state === 'ready',
          control: view.capabilities.includes('sessions.control'),
          repositories: view.repositories.map(({ id, name }) => ({ id, name })),
        },
      ]
    })
  }
  function map(host: string, r: NonNullable<ReturnType<typeof parseRoutineList>>[number]): Routine {
    const view = admitted(host).snapshot()
    const repository = view.repositories.find((entry) => entry.id === r.repositoryId)
    if (!repository) throw new Error(UNAVAILABLE)
    const { repositoryId, ...config } = r
    return {
      ...config,
      id: key(host, r.id),
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
  async function query(host: string, method: string, params: unknown): Promise<unknown> {
    const connection = admitted(host)
    if (!parseRoutineParams(method, params)) throw new Error(UNAVAILABLE)
    let result
    try {
      result = await connection.call(method, params)
    } catch {
      throw new Error(UNAVAILABLE)
    }
    admitted(host, false, connection)
    if (!result.ok) throw new Error(UNAVAILABLE)
    return result.data
  }
  async function list(host: string): Promise<RoutinesSnapshot> {
    const connection = admitted(host)
    const rows = parseRoutineList(await query(host, 'routines.list', {}))
    admitted(host, false, connection)
    if (!rows) throw new Error(UNAVAILABLE)
    const routines = rows.map((r) => map(host, r))
    if (!definitions.has(host) && definitions.size >= 32) {
      const oldest = definitions.keys().next().value
      if (oldest) definitions.delete(oldest)
    }
    definitions.set(host, routines)
    uncertain.delete(host)
    return { routines, runs: [], background: false, error: null }
  }
  async function history(host: string, id: string, offset: unknown): Promise<RoutineRun[]> {
    const connection = admitted(host)
    const rows = parseRoutineHistory(
      await query(host, 'routines.history', { routineId: id, offset }),
    )
    admitted(host, false, connection)
    if (!rows || rows.some((r) => r.routineId !== id)) throw new Error(UNAVAILABLE)
    const snapshot = await list(host)
    admitted(host, false, connection)
    const definition = snapshot.routines.find((r) => r.id === key(host, id))
    if (!definition) throw new Error(UNAVAILABLE)
    return rows.map((r) => runRecord(host, r, definition))
  }
  function runRecord(
    host: string,
    r: NonNullable<ReturnType<typeof parseRoutineHistory>>[number],
    definition: Routine,
  ): RoutineRun {
    return {
      ...r,
      id: key(host, r.id),
      routineId: key(host, r.routineId),
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
  async function run(host: string, id: string): Promise<RoutineRun> {
    const connection = admitted(host, true)
    const definition = definitions.get(host)?.find((r) => r.id === key(host, id))
    if (!definition) throw new Error(UNAVAILABLE)
    const runId = await mutate(host, { type: 'routine.run', routineId: id })
    admitted(host, true, connection)
    if (!runId) throw new Error(UNAVAILABLE)
    let rows: ReturnType<typeof parseRoutineHistory> = null
    try {
      rows = parseRoutineHistory(
        await query(host, 'routines.history', { routineId: id, offset: 0 }),
      )
    } catch {
      /* The confirmed run is not retried when its history is unavailable. */
    }
    admitted(host, true, connection)
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

  async function mutate(host: string, raw: unknown): Promise<string | undefined> {
    if (uncertain.has(host)) throw new Error(ROUTINE_UNKNOWN)
    const op = parseRoutineOp(raw)
    if (!op) throw new Error(UNAVAILABLE)
    const control = routineRequiresControl(op)
    const connection = admitted(host, control)
    if (
      op.type === 'routine.save' &&
      !connection.snapshot().repositories.some((r) => r.id === op.routine.repositoryId)
    )
      throw new Error(UNAVAILABLE)
    let result
    try {
      result = await connection.send(op)
    } catch {
      uncertain.add(host)
      throw new Error(ROUTINE_UNKNOWN)
    }
    if (result.status === 'unknown' || result.status === 'pending') {
      uncertain.add(host)
      throw new Error(ROUTINE_UNKNOWN)
    }
    admitted(host, control, connection)
    if (result.status === 'done' && !parseRoutineReceiptData(op, result.data)) {
      uncertain.add(host)
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
  function route(channel: IpcInvokeChannel, args: unknown[]): { result: Promise<unknown> } | null {
    if (!channel.startsWith('routines:')) return null
    const location = channel === 'routines:save' ? (args[3] ?? args[1]) : args[0]
    if (typeof location !== 'string' || !location.startsWith('host:')) return null
    const t = target(location)
    if (!t) throw new Error(UNAVAILABLE)
    if (channel === 'routines:list' && !t.id) return { result: list(t.host) }
    if (channel === 'routines:run' && t.id) return { result: run(t.host, t.id) }
    if (channel === 'routines:history' && t.id) return { result: history(t.host, t.id, args[1]) }
    let op: unknown
    if (channel === 'routines:save') {
      const raw = args[0]
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(UNAVAILABLE)
      const input = raw as Record<string, unknown>
      const saved = args[1] === undefined ? null : target(args[1])
      if (args[1] !== undefined && (!saved?.id || saved.host !== t.host))
        throw new Error(UNAVAILABLE)
      // Pick only wire fields: renderer labels and metadata are never forwarded.
      const fields = [
        'name',
        'instructions',
        'isolated',
        'intent',
        'provider',
        'model',
        'timezone',
        'schedule',
        'period',
        'catchUpHours',
        'maxRuntimeMinutes',
        'enabled',
        'trusted',
      ]
      const routine = Object.fromEntries(fields.map((field) => [field, input[field]]))
      op = {
        type: 'routine.save',
        routine: {
          ...routine,
          repositoryId:
            input.repositoryId ??
            (input.machine && typeof input.machine === 'object'
              ? (input.machine as Record<string, unknown>).repositoryId
              : undefined),
          ...(!saved ? { enabled: false, trusted: false } : {}),
        },
        expectedRevision: args[2] ?? null,
        ...(saved ? { routineId: saved.id } : {}),
      }
    } else if (channel === 'routines:pauseAll' && !t.id) op = { type: 'routine.pauseAll' }
    else if (t.id && channel === 'routines:cancel') op = { type: 'routine.cancel', runId: t.id }
    else if (
      t.id &&
      ['routines:run', 'routines:skipNext', 'routines:archive', 'routines:delete'].includes(channel)
    )
      op = { type: channel.replace('routines:', 'routine.') as RoutineOp['type'], routineId: t.id }
    else throw new Error(UNAVAILABLE)
    return { result: mutate(t.host, op) }
  }
  return {
    machines,
    route,
    clear: () => {
      definitions.clear()
      uncertain.clear()
    },
  }
}
