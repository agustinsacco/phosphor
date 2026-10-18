import type { IpcInvokeChannel } from '@phosphor/shared/ipc'
import {
  createRemoteRoutineState,
  clearRemoteRoutineState,
  machines,
  type RemoteRoutinePorts,
} from './routines/state'
import { route } from './routines/route'

export { ROUTINE_UNKNOWN } from './routines/state'

/** Machine operations deliberately have no lane or fence. No errors from the Host cross IPC. */
export function createRemoteRoutines(ports: RemoteRoutinePorts) {
  const state = createRemoteRoutineState()
  return {
    machines: () => machines(state, ports),
    route: (channel: IpcInvokeChannel, args: unknown[]) => route(state, ports, channel, args),
    clear: () => clearRemoteRoutineState(state),
  }
}
