import { ipcMain } from 'electron'
import { REMOTE_UNAVAILABLE } from '@phosphor/host-client/lane-ops'
import { LOCAL_ROUTE, resolvesSameMachine } from '@phosphor/shared/ipc-local-route'
import { InAppRuntimeRefused, localRuntimeMode } from '../local-machine/mode'
import { sameMachineArgs } from '../local-machine/same-machine'
import { isMachineChannel, refusesMachineResourceArgs } from './machine-resource-args'
import { admitSender } from './sender-policy'
import type { IpcInvokeChannel, IpcInvokeMap } from '@shared/ipc'

type Handler<C extends IpcInvokeChannel> = (
  event: Electron.IpcMainInvokeEvent,
  ...args: IpcInvokeMap[C]['args']
) => Promise<IpcInvokeMap[C]['result']> | IpcInvokeMap[C]['result']

let remoteRead:
  | ((
      windowId: number,
      channel: IpcInvokeChannel,
      args: unknown[],
    ) => { result: Promise<unknown> } | null)
  | undefined
export function setRemoteReadRouter(router: NonNullable<typeof remoteRead>): void {
  remoteRead = router
}

/** Refuse a call whose declared resource positions are remote or malformed. */
export function rejectRemoteArguments(channel: IpcInvokeChannel, args: readonly unknown[]): void {
  if (refusesMachineResourceArgs(channel, args)) throw new Error(REMOTE_UNAVAILABLE)
}

/**
 * Daemon mode only: a same-machine call naming This Mac's `host:` keys, with
 * them resolved to real paths (`LOCAL_ROUTE`); null for every other call.
 */
function sameMachineCall(channel: IpcInvokeChannel, args: unknown[]): unknown[] | null {
  if (!isMachineChannel(channel) || !resolvesSameMachine(LOCAL_ROUTE[channel])) return null
  const resolved = sameMachineArgs(channel, args)
  if (resolved) rejectRemoteArguments(channel, resolved)
  return resolved
}

/**
 * Register one typed IPC invoke handler. The sender is admitted before any
 * route. In daemon mode This Mac's keys resolve first for same-machine
 * channels, and an in-app-only handler is refused after the remote router.
 */
export function handle<C extends IpcInvokeChannel>(channel: C, handler: Handler<C>): void {
  ipcMain.handle(channel, (event, ...args: IpcInvokeMap[C]['args']) => {
    admitSender(event)
    const daemon = localRuntimeMode() === 'daemon'
    const local = daemon ? sameMachineCall(channel, args) : null
    if (local) return handler(event, ...(local as IpcInvokeMap[C]['args']))
    const remote = remoteRead?.(event.sender.id, channel, args)
    if (remote) return remote.result
    rejectRemoteArguments(channel, args)
    if (daemon && isMachineChannel(channel) && LOCAL_ROUTE[channel] === 'in-app-only')
      throw new InAppRuntimeRefused(channel)
    return handler(event, ...args)
  })
}
