import type { FrameSocket } from '../host-protocol'
import type { ExtensionUIRequest } from '../rpc'
import { attach } from './fake-host/connections'
import * as driver from './fake-host/driver'
import { createFakeHostState, type FakeHostOptions } from './fake-host/state'

export type { FakeHostOptions } from './fake-host/state'

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
    stop: () => driver.stop(state),
  }
}
