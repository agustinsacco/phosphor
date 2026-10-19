import type {
  TerminalOp,
  TerminalInput,
  TerminalSubscribe,
  TerminalFrame,
} from '@phosphor/shared/host-protocol-terminals'
import { createTerminalState, type TerminalOptions } from './service-state'
import { persist, reap, close, presence, authorizationChanged } from './lifecycle'
import { execute, input, terminalFeature } from './operations'
import { loginRunner, machineOp, completeLogin } from './login-runner'
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
    input: (clientId: string, raw: TerminalInput, configuration?: boolean) =>
      input(state, clientId, raw, configuration),
    subscribe: (
      frame: TerminalSubscribe,
      send: (frame: TerminalFrame) => void,
      clientId?: string,
      configuration?: () => boolean,
    ) => subscribe(state, () => reap(state), frame, send, clientId, configuration),
    feature: terminalFeature(state),
    close: () => close(state),
    loginRunner: (
      owner: string,
      started: (id: string) => void,
      configuration?: boolean,
      deferExit?: boolean,
      authorized?: () => boolean,
    ) => loginRunner(state, owner, started, configuration, deferExit, authorized),
    completeLogin: (owner: string, id: string, exitCode: number) =>
      completeLogin(state, owner, id, exitCode),
    machineOp: (owner: string, op: TerminalOp, configuration?: boolean) =>
      machineOp(state, owner, op, configuration),
    authorizationChanged: () => authorizationChanged(state),
    presence: (owner: string, connected: boolean, revoked?: boolean) =>
      presence(state, owner, connected, revoked),
  }
}
export type HostTerminals = ReturnType<typeof createTerminals>
