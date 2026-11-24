import type { FrameSocket } from '../host-protocol'
import type { ExtensionUIRequest } from '../rpc'
import { attach } from './fake-host/connections'
import * as driver from './fake-host/driver'
import type { FakeOpsHandler } from './fake-host/ops'
import { createFakeHostState, type FakeHostOptions } from './fake-host/state'

export type { FakeHostOptions } from './fake-host/state'
export type { FakeOpsHandler } from './fake-host/ops'

/** In-memory executable protocol model. It never starts pi, reads disk or opens a listener. */
export function createFakeHost(options: FakeHostOptions) {
  const state = createFakeHostState(options)
  return {
    attach: (socket: FrameSocket) => attach(state, socket),
    emitTurn: (id: string) => driver.emitTurn(state, id),
    emitUi: (id: string, request: ExtensionUIRequest) => driver.emitUi(state, id, request),
    openDialog: (id: string, dialogId = 'dialog') => driver.openDialog(state, id, dialogId),
    failLane: (id: string) => driver.failLane(state, id),
    restart: () => driver.restart(state),
    revokeSession: (id: string) => driver.revokeSession(state, id),
    revokeClient: (id: string) => driver.revokeClient(state, id),
    executions: () => state.executions,
    /** Serves `ops.run` with `handler` and announces `ready.ops` from now on; null stops. */
    ops: (handler: FakeOpsHandler | null) => {
      state.ops = handler
    },
    stop: () => driver.stop(state),
  }
}
