import type {
  TerminalOp,
  TerminalInput,
  TerminalSubscribe,
  TerminalFrame,
} from '@phosphor/shared/host-protocol-terminals'
import { createTerminalState, type TerminalOptions } from './service-state'
import { persist, reap, close, presence } from './lifecycle'
import { execute, input, terminalFeature } from './operations'
import { loginRunner, machineOp } from './login-runner'
import { subscribe } from './subscriptions'

export { TerminalForbidden } from './operations'

export function createTerminals(options: TerminalOptions) {
  const state = createTerminalState(options)
  persist(state)
  // Deleted lanes lose their PTYs even when no client remains connected.
  state.timer = setInterval(() => {
    try {
      reap(state)
    } catch {
      close(state)
    }
  }, 1000)
  state.timer.unref()
  return {
    execute: (laneId: string, op: TerminalOp, authorized?: () => boolean) =>
      execute(state, laneId, op, authorized),
    input: (clientId: string, raw: TerminalInput) => input(state, clientId, raw),
    subscribe: (
      frame: TerminalSubscribe,
      send: (frame: TerminalFrame) => void,
      clientId?: string,
    ) => subscribe(state, () => reap(state), frame, send, clientId),
    feature: terminalFeature(state),
    close: () => close(state),
    loginRunner: (owner: string, started: (id: string) => void) =>
      loginRunner(state, owner, started),
    machineOp: (owner: string, op: TerminalOp) => machineOp(state, owner, op),
    presence: (owner: string, connected: boolean, revoked?: boolean) =>
      presence(state, owner, connected, revoked),
  }
}
export type HostTerminals = ReturnType<typeof createTerminals>
