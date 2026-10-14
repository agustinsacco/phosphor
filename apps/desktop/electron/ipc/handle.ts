import { ipcMain } from 'electron'
import { IPC_SCOPE } from '@shared/ipc-scope'
import { REMOTE_UNAVAILABLE } from '../hosts/lane-ops'
import type { IpcInvokeChannel, IpcInvokeMap } from '@shared/ipc'

type Handler<C extends IpcInvokeChannel> = (
  event: Electron.IpcMainInvokeEvent,
  ...args: IpcInvokeMap[C]['args']
) => Promise<IpcInvokeMap[C]['result']> | IpcInvokeMap[C]['result']

const routed = new Set<IpcInvokeChannel>([
  'pi:command',
  'pi:extensionUiResponse',
  'pi:disposeSession',
  'pi:listLiveSessions',
])
export function rejectRemoteArguments(channel: IpcInvokeChannel, args: unknown[]): void {
  if (IPC_SCOPE[channel] !== 'machine' || routed.has(channel)) return
  // Inspect nested options as well as positional paths. Bound traversal fail-closed.
  let remaining = 4096
  function visit(value: unknown, depth: number): boolean {
    if (--remaining < 0 || depth > 16) return true
    if (typeof value === 'string')
      return value.startsWith('host:') || /^remote-[0-9a-f]{16}$/.test(value)
    if (Array.isArray(value)) return value.some((v) => visit(v, depth + 1))
    if (value && typeof value === 'object')
      return Object.values(value).some((v) => visit(v, depth + 1))
    return false
  }
  if (visit(args, 0)) throw new Error(REMOTE_UNAVAILABLE)
}

/** Register one typed IPC invoke handler. */
export function handle<C extends IpcInvokeChannel>(channel: C, handler: Handler<C>): void {
  ipcMain.handle(channel, (event, ...args: IpcInvokeMap[C]['args']) => {
    rejectRemoteArguments(channel, args)
    return handler(event, ...args)
  })
}
