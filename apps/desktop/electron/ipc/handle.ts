import { ipcMain } from 'electron'
import { REMOTE_UNAVAILABLE } from '../hosts/lane-ops'
import { refusesMachineResourceArgs } from './machine-resource-args'
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

/** Register one typed IPC invoke handler. */
export function handle<C extends IpcInvokeChannel>(channel: C, handler: Handler<C>): void {
  ipcMain.handle(channel, (event, ...args: IpcInvokeMap[C]['args']) => {
    const remote = remoteRead?.(event.sender.id, channel, args)
    if (remote) return remote.result
    rejectRemoteArguments(channel, args)
    return handler(event, ...args)
  })
}
