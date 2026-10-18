import type { IpcInvokeChannel } from '@phosphor/shared/ipc'
import type { RoutineOp } from '@phosphor/shared/host-protocol-routines'
import { UNAVAILABLE, type RemoteRoutinePorts, type RemoteRoutineState } from './state'
import { list, run, history, mutate } from './operations'

const target = (value: unknown): { host: string; id?: string } | null => {
  if (typeof value !== 'string') return null
  const match = /^host:([0-9a-f-]{36})(?:\/([0-9a-f-]{36}))?$/i.exec(value)
  return match?.[1] ? { host: match[1], id: match[2] } : null
}

function saveOperation(host: string, args: unknown[]): unknown {
  const raw = args[0]
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw new Error(UNAVAILABLE)
  const input = raw as Record<string, unknown>
  const saved = args[1] === undefined ? null : target(args[1])
  if (args[1] !== undefined && (!saved?.id || saved.host !== host)) throw new Error(UNAVAILABLE)
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
  return {
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
}

export function route(
  state: RemoteRoutineState,
  ports: RemoteRoutinePorts,
  channel: IpcInvokeChannel,
  args: unknown[],
): { result: Promise<unknown> } | null {
  if (!channel.startsWith('routines:')) return null
  const location = channel === 'routines:save' ? (args[3] ?? args[1]) : args[0]
  if (typeof location !== 'string' || !location.startsWith('host:')) return null
  const t = target(location)
  if (!t) throw new Error(UNAVAILABLE)
  if (channel === 'routines:list' && !t.id) return { result: list(state, ports, t.host) }
  if (channel === 'routines:run' && t.id) return { result: run(state, ports, t.host, t.id) }
  if (channel === 'routines:history' && t.id)
    return { result: history(state, ports, t.host, t.id, args[1]) }
  let op: unknown
  if (channel === 'routines:save') op = saveOperation(t.host, args)
  else if (channel === 'routines:pauseAll' && !t.id) op = { type: 'routine.pauseAll' }
  else if (t.id && channel === 'routines:cancel') op = { type: 'routine.cancel', runId: t.id }
  else if (
    t.id &&
    ['routines:run', 'routines:skipNext', 'routines:archive', 'routines:delete'].includes(channel)
  )
    op = { type: channel.replace('routines:', 'routine.') as RoutineOp['type'], routineId: t.id }
  else throw new Error(UNAVAILABLE)
  return { result: mutate(state, ports, t.host, op) }
}
