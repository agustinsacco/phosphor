import type {
  ExtensionUIRequest,
  AgentMessage,
  PiEvent,
  RpcSessionState,
} from '@phosphor/shared/rpc'
import type { PendingSizes } from './projection-pending'

export type ProjectionOptions = { now: () => number; overflow: () => void }
export interface ProjectionState {
  session: RpcSessionState | null
  messages: AgentMessage[]
  tail: PiEvent[]
  run?: PiEvent
  queue?: Extract<PiEvent, { type: 'queue_update' }>
  retry?: PiEvent
  compaction?: PiEvent
  ended?: 'stopped' | 'failed'
  active: boolean
  messageStarted: boolean
  discarding: boolean
  barrier?: PiEvent[]
  sinceMark?: AgentMessage[]
  read?: number
  dialogs: Map<string, { request: ExtensionUIRequest; expires?: number }>
  statuses: Map<string, ExtensionUIRequest>
  widgets: Map<string, ExtensionUIRequest>
  title?: ExtensionUIRequest
  /** pi-subagents' fleet widget reports live or unprovable delegated work. */
  delegated: boolean
  sequence: number
  order: WeakMap<PiEvent, number>
  sizes: PendingSizes
  /** Running JSON bytes of `tail` and `barrier`, kept by every change to either list. */
  bytes: Record<PendingList, number>
}
export type PendingList = 'tail' | 'barrier'
