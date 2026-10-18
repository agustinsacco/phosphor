import type { TerminalFrame } from '@phosphor/shared/host-protocol-terminals'
import {
  HOST_LIMITS,
  type ClientFrame,
  type HostFrame,
  type StreamCursor,
} from '@phosphor/shared/host-protocol'
import type { IdentityCrypto } from '../crypto'

type Timer = ReturnType<typeof setTimeout>
export type LaneFrame = Extract<HostFrame, { type: 'snapshot' | 'event' | 'subscribe-failed' }>
export type TerminalListener = (
  frame: TerminalFrame | Extract<HostFrame, { type: 'subscribe-failed' }>,
) => void

/** One connection's lane watches, terminal watches and unacknowledged terminal inputs. */
export interface SubscriptionState {
  readonly watches: Map<
    string,
    { laneId: string; cursor?: StreamCursor; listener: (frame: LaneFrame) => void }
  >
  readonly terminals: Map<string, { terminalId: string; listener: TerminalListener }>
  /** At most one input in flight per terminal, settled by its ack, a timeout or a disconnect. */
  readonly inputs: Map<string, { seq: number; resolve: (accepted: boolean) => void }>
}

export interface SubscriptionPorts {
  identity: Pick<IdentityCrypto, 'randomUUID' | 'randomHex'>
  write: (frame: ClientFrame) => boolean
  later: (fn: () => void, ms: number) => Timer
  /** Clears a timer `later` made and forgets it. */
  cancel: (timer: Timer) => void
  unrefTimer?: (timer: Timer) => void
  transportFailed: () => void
  ready: () => boolean
  stopped: () => boolean
}

const INPUT_ACK_MS = 5000

export function createSubscriptionState(): SubscriptionState {
  return { watches: new Map(), terminals: new Map(), inputs: new Map() }
}

/** The lanes list without a lane id, one lane's stream with it. A refused write fails the transport. */
export function subscribeLanes(
  ports: SubscriptionPorts,
  id: string,
  laneId?: string,
  after?: StreamCursor,
): void {
  const sent = ports.write(
    laneId
      ? {
          type: 'subscribe',
          id,
          topic: 'lane',
          laneId,
          after,
          trace: ports.identity.randomHex(8),
        }
      : { type: 'subscribe', id, topic: 'lanes', after, trace: ports.identity.randomHex(8) },
  )
  if (!sent) ports.transportFailed()
}

export function subscribeTerminal(ports: SubscriptionPorts, id: string, terminalId: string): void {
  if (!ports.write({ type: 'subscribe', topic: 'terminal', id, terminalId }))
    ports.transportFailed()
}

/** On ready: the lanes list from its cursor, each lane watch from its own, then each terminal. */
export function resubscribe(
  state: SubscriptionState,
  ports: SubscriptionPorts,
  after: StreamCursor | undefined,
): void {
  subscribeLanes(ports, 'lanes', undefined, after)
  for (const [id, w] of state.watches) subscribeLanes(ports, id, w.laneId, w.cursor)
  for (const [id, w] of state.terminals) subscribeTerminal(ports, id, w.terminalId)
}

/** Lane watches alone may use every subscription but the lanes list's. */
export function watchLane(
  state: SubscriptionState,
  ports: SubscriptionPorts,
  laneId: string,
  listener: (frame: LaneFrame) => void,
): () => void {
  if (ports.stopped() || state.watches.size >= HOST_LIMITS.subscriptionsPerConnection - 1)
    throw new Error('Subscription unavailable.')
  const id = ports.identity.randomUUID()
  state.watches.set(id, { laneId, listener })
  if (ports.ready()) subscribeLanes(ports, id, laneId)
  return () => {
    state.watches.delete(id)
    if (ports.ready()) ports.write({ type: 'unsubscribe', id })
  }
}

/** A terminal watch counts lane watches too, so terminals can never starve lanes. */
export function watchTerminal(
  state: SubscriptionState,
  ports: SubscriptionPorts,
  terminalId: string,
  listener: TerminalListener,
): { reset: () => void; close: () => void } {
  if (
    ports.stopped() ||
    state.watches.size + state.terminals.size >= HOST_LIMITS.subscriptionsPerConnection - 1
  )
    throw new Error('Subscription unavailable.')
  const id = ports.identity.randomUUID()
  state.terminals.set(id, { terminalId, listener })
  if (ports.ready()) subscribeTerminal(ports, id, terminalId)
  return {
    reset: () => subscribeTerminal(ports, id, terminalId),
    close: () => {
      state.terminals.delete(id)
      if (ports.ready()) ports.write({ type: 'unsubscribe', id })
    },
  }
}

export function sendInput(
  state: SubscriptionState,
  ports: SubscriptionPorts,
  terminalId: string,
  seq: number,
  data: string,
): Promise<boolean> {
  if (ports.stopped() || !ports.ready() || state.inputs.has(terminalId))
    return Promise.resolve(false)
  return new Promise((resolve) => {
    const timer = ports.later(() => {
      const pending = state.inputs.get(terminalId)
      if (pending?.seq === seq) {
        state.inputs.delete(terminalId)
        pending.resolve(false)
      }
    }, INPUT_ACK_MS)
    const settle = (accepted: boolean) => {
      ports.cancel(timer)
      resolve(accepted)
    }
    state.inputs.set(terminalId, { seq, resolve: settle })
    ports.unrefTimer?.(timer)
    if (!ports.write({ type: 'terminal.input', terminalId, seq, data })) {
      state.inputs.delete(terminalId)
      settle(false)
      ports.transportFailed()
    }
  })
}

/** Only the ack for the input in flight settles it; any other sequence is stale. */
export function ackInput(
  state: SubscriptionState,
  f: Extract<TerminalFrame, { type: 'terminal.ack' }>,
): void {
  const input = state.inputs.get(f.terminalId)
  if (input?.seq === f.seq) {
    state.inputs.delete(f.terminalId)
    input.resolve(f.accepted)
  }
}

export function dropInputs(state: SubscriptionState): void {
  for (const input of state.inputs.values()) input.resolve(false)
  state.inputs.clear()
}

export function clearSubscriptions(state: SubscriptionState): void {
  state.watches.clear()
  state.terminals.clear()
  dropInputs(state)
}
