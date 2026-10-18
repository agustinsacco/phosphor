import type { GrantExpectations, GrantPayload } from '../../host-grant'
import {
  HOST_LIMITS,
  type AttentionEvent,
  type ClientFrame,
  type FrameSocket,
  type LaneEvent,
  type LaneSummary,
  type Receipt,
  type RepositorySummary,
  type StreamCursor,
} from '../../host-protocol'
import type { HostCapability } from '../../remote-host'
import type { AgentMessage, ExtensionUIRequest, PiEvent, ThinkingLevel } from '../../rpc'

export type Limits = { -readonly [K in keyof typeof HOST_LIMITS]: number }
export type Command = Extract<ClientFrame, { type: 'command' }>
export interface Lane {
  summary: LaneSummary
  thinkingLevel: ThinkingLevel
  sessionId: string
  seq: number
  events: { cursor: StreamCursor; event: LaneEvent; bytes: number }[]
  replayBytes: number
  messages: AgentMessage[]
  pending: PiEvent[]
  dialogs: ExtensionUIRequest[]
  ui: Map<string, ExtensionUIRequest>
}
export interface Connection {
  socket: FrameSocket
  grant: GrantPayload | null
  subscriptions: Map<string, Extract<ClientFrame, { type: 'subscribe'; topic: 'lanes' | 'lane' }>>
  wanted: Set<string>
  delivered: Set<string>
  pending: number
  calls: number
  stale: Set<string>
  recoveryTimer?: ReturnType<typeof setTimeout>
  authTimer: ReturnType<typeof setTimeout>
  expiryTimer?: ReturnType<typeof setTimeout>
  idleTimer?: ReturnType<typeof setTimeout>
}
export interface Stored {
  clientId: string
  hash: string
  receipt: Receipt
  finishedAt?: number
}
export interface FakeHostOptions {
  expectations: Omit<GrantExpectations, 'revokedSessions' | 'revokedClients'>
  verify: (bytes: Uint8Array, signature: Uint8Array, kid: string) => boolean
  sign: (bytes: Uint8Array) => Uint8Array
  verifyGrant?: (token: string) => GrantPayload | null
  id: () => string
  epoch: () => string
  capabilities?: readonly HostCapability[]
  repositories?: readonly RepositorySummary[]
  limits?: Partial<Limits>
  commandDelayMs?: number
}

/** One fake Host's mutable model. Every Host instance owns its own; nothing is module-global. */
export interface FakeHostState {
  readonly options: FakeHostOptions
  readonly limits: Limits
  readonly caps: readonly HostCapability[]
  readonly repositories: readonly RepositorySummary[]
  readonly connections: Set<Connection>
  readonly lanes: Map<string, Lane>
  readonly receipts: Map<string, Stored>
  readonly revokedSessions: Set<string>
  readonly revokedClients: Set<string>
  readonly attention: { cursor: StreamCursor; event: AttentionEvent }[]
  /** Command and call timers; restart and stop clear them. */
  readonly timers: Set<ReturnType<typeof setTimeout>>
  epoch: string
  hostSeq: number
  stopped: boolean
  executions: number
}

/** A fake may only lower the contract's limits, by positive safe integers. */
export function resolveLimits(requested: Partial<Limits> | undefined): Limits {
  const limits: Limits = { ...HOST_LIMITS }
  for (const key in HOST_LIMITS) {
    if (!limitKey(key)) continue
    const value = requested?.[key]
    if (value !== undefined) {
      if (!Number.isSafeInteger(value) || value < 1 || value > limits[key])
        throw new Error('Invalid limit')
      limits[key] = value
    }
  }
  return limits
}

/** Validates options before the first `epoch()` call, so a refused Host consumes no epoch. */
export function createFakeHostState(options: FakeHostOptions): FakeHostState {
  const limits = resolveLimits(options.limits)
  const caps = options.capabilities ?? ['sessions.read', 'sessions.control']
  const repositories = options.repositories ?? [
    { id: '0123456789abcdef', name: 'Test repository', path: '/test/repository' },
  ]
  if (repositories.length > limits.repositoriesPerHost) throw new Error('Too many repositories')
  return {
    options,
    limits,
    caps,
    repositories,
    connections: new Set(),
    lanes: new Map(),
    receipts: new Map(),
    revokedSessions: new Set(),
    revokedClients: new Set(),
    attention: [],
    timers: new Set(),
    epoch: options.epoch(),
    hostSeq: 0,
    stopped: false,
    executions: 0,
  }
}

export const now = () => new Date().toISOString()

function limitKey(key: string): key is keyof Limits {
  return key in HOST_LIMITS
}
