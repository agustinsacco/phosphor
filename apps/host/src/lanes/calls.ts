import { isUuid } from '@phosphor/shared/control-api'
import { HOST_LIMITS } from '@phosphor/shared/host-protocol'
import type { RpcCommand, RpcResponse } from '@phosphor/shared/rpc'
import type { RuntimeLog } from '@phosphor/session-runtime/file-log'
import type { HostRuntime } from '../session/runtime'
import type { createLiveLanes } from './live'
import { piMessages, piState } from './pi-results'
import type { SnapshotResult } from './projection-host'
import type { CallOutcome } from './service'
import type { HostStore } from './store'
import type { HostCapability } from '@phosphor/shared/remote-host'
import type { HostFeature } from '../features/feature'

const record = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value)
const queries = new Map<string, RpcCommand>([
  ['lane.state', { type: 'get_state' }],
  ['lane.messages', { type: 'get_messages' }],
  ['lane.stats', { type: 'get_session_stats' }],
  ['lane.models', { type: 'get_available_models' }],
  ['lane.commands', { type: 'get_commands' }],
])
const failure = (code: Extract<CallOutcome, { ok: false }>['error']['code']): CallOutcome => ({
  ok: false,
  error: { code, message: 'the lane query could not complete' },
})
function shape(method: string, data: unknown): boolean {
  if (method === 'lane.state') return piState(data) !== null
  if (!record(data)) return false
  if (method === 'lane.messages') return piMessages(data.messages) !== null
  if (method === 'lane.models') return Array.isArray(data.models)
  if (method === 'lane.commands') return Array.isArray(data.commands)
  const tokens = data.tokens
  return (
    [
      'userMessages',
      'assistantMessages',
      'toolCalls',
      'toolResults',
      'totalMessages',
      'cost',
    ].every((key) => typeof data[key] === 'number' && Number.isFinite(data[key])) &&
    record(tokens) &&
    ['input', 'output', 'cacheRead', 'cacheWrite', 'total'].every(
      (key) => typeof tokens[key] === 'number' && Number.isFinite(tokens[key]),
    )
  )
}

export function createLaneCalls(options: {
  store: Pick<HostStore, 'listRepositories' | 'getLane'>
  live: Pick<ReturnType<typeof createLiveLanes>, 'sessionFor'>
  runtime: { command(...args: Parameters<HostRuntime['command']>): Promise<RpcResponse> }
  unattached(laneId: string): SnapshotResult | null
  now(): number
  log: RuntimeLog
  features?: readonly HostFeature[]
}) {
  const features = new Map<string, HostFeature>()
  for (const feature of options.features ?? [])
    for (const method of feature.methods) features.set(method, feature)
  return {
    capabilityFor(method: string): HostCapability | null {
      if (method === 'host.repositories' || queries.has(method)) return 'sessions.read'
      return features.get(method)?.capability ?? null
    },
    async call(method: string, params: unknown): Promise<CallOutcome> {
      const feature = features.get(method)
      if (feature) return feature.call(method, params)
      const command = queries.get(method)
      if (method !== 'host.repositories' && !command) return failure('unsupported')
      if (!record(params)) return failure('bad-request')
      if (method === 'host.repositories')
        return { ok: true, data: options.store.listRepositories() }
      if (!command) return failure('unsupported')
      const laneId = params.laneId
      if (typeof laneId !== 'string' || !isUuid(laneId)) return failure('bad-request')
      const lane = options.store.getLane(laneId)
      if (!lane || lane.removedAt !== null) return failure('unknown-lane')
      const sessionId = options.live.sessionFor(laneId)
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        if (sessionId === null) {
          if (method === 'lane.state') return { ok: true, data: null }
          if (method !== 'lane.messages') return failure('lane-stopped')
          const snapshot = options.unattached(laneId)
          if (snapshot === null) return failure('internal')
          return snapshot.ok
            ? { ok: true, data: { messages: snapshot.snapshot.messages } }
            : failure('too-large')
        }
        const response = await Promise.race([
          options.runtime.command(sessionId, command),
          new Promise<null>((resolve) => {
            timer = setTimeout(() => resolve(null), HOST_LIMITS.commandAnswerMs)
            timer.unref()
          }),
        ])
        if (!response?.success || !shape(method, response.data)) return failure('internal')
        return { ok: true, data: response.data }
      } catch {
        return failure('internal')
      } finally {
        clearTimeout(timer)
      }
    },
  }
}
