/**
 * Who each turn of Brain Agent's reserved lane acts for. The Host sends every prompt, and names
 * its turn before sending it: a controller's message, or Defrag's. One named turn at a time: a
 * second prompt is not sent while one holds the lane. The name holds until the turn settles or
 * the lane exits, and a turn pi starts with no name gets no authority at all.
 *
 * A controller's turn runs on their authority: once stopped or revoked, Brain Agent's tools
 * refuse before pi acknowledges the abort. Revocation is checked on events and a short timer.
 * Each turn has an opaque reference, so a Stop names the turn its client saw, never a later one.
 */
import { randomUUID } from 'node:crypto'
import type { BrainAgentTurnGate } from '@phosphor/brain-runtime/types'
import type { BrainSurfaceAuthority } from '../../api/brain-adapter'

export type TurnIdentity =
  | { readonly kind: 'controller'; readonly ref: string; readonly caller: BrainSurfaceAuthority }
  | { readonly kind: 'defrag'; readonly ref: string }

export const controllerTurn = (caller: BrainSurfaceAuthority): TurnIdentity => ({
  kind: 'controller',
  ref: randomUUID(),
  caller,
})
export const defragTurn = (): TurnIdentity => ({ kind: 'defrag', ref: randomUUID() })

/** Whether `turn` is a controller turn `caller` started. */
export const startedBy = (turn: TurnIdentity | null, caller: BrainSurfaceAuthority): boolean =>
  turn?.kind === 'controller' && turn.caller.client.id === caller.client.id

const REVOCATION_POLL_MS = 250

export function createTurnIdentities(abort: (identity: TurnIdentity) => void) {
  let current: TurnIdentity | null = null
  let running = false
  let cancelled = false
  let timer: NodeJS.Timeout | undefined

  const authorized = (identity: TurnIdentity) =>
    identity.kind === 'defrag' || identity.caller.admit()

  function cancel(identity: TurnIdentity): boolean {
    if (current !== identity || cancelled) return false
    cancelled = true
    return true
  }
  function check(): void {
    const identity = current
    if (identity && !authorized(identity) && cancel(identity)) abort(identity)
  }
  function clear(): void {
    current = null
    running = false
    cancelled = false
    clearInterval(timer)
    timer = undefined
  }

  return {
    /** Names the next turn; false while another named turn holds the lane. */
    claim(identity: TurnIdentity): boolean {
      if (current) return false
      current = identity
      if (identity.kind === 'controller') {
        timer = setInterval(check, REVOCATION_POLL_MS)
        timer.unref()
      }
      return true
    },
    /** The named turn was not cancelled during preflight. */
    mayDispatch: (identity: TurnIdentity) => current === identity && !cancelled && !running,
    /** pi refused the prompt: the name goes unless its turn already started. */
    release(identity: TurnIdentity): void {
      if (current === identity && !running) clear()
    },
    /** One event of the lane's process, in order. */
    event(type: string): void {
      if (type === 'agent_start') running = true
      if (type === 'agent_settled') clear()
      else check()
    },
    exit: clear,
    /** Closes this turn's effect gate now, without giving up its lane before settlement. */
    cancel,
    /** The named turn, from just before its prompt goes until it settles; or null. */
    named: (): TurnIdentity | null => current,
    /** The named turn once pi runs it, or null. */
    running: (): TurnIdentity | null => (running ? current : null),
    /** The running turn's gate, bound to that turn only; null when none of known identity runs. */
    gate(): BrainAgentTurnGate | null {
      const identity = current
      if (!identity || !running) return null
      return {
        kind: identity.kind,
        admit: () => current === identity && running && !cancelled && authorized(identity),
      }
    },
  }
}

export type TurnIdentities = ReturnType<typeof createTurnIdentities>
