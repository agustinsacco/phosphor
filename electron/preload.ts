import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { IpcInvokeChannel, IpcInvokeMap, PhosphorApi } from '@shared/ipc'
import { sessionEventChannel } from '@shared/ipc'
import type {
  SessionPush,
  UpdateState,
  LoginFlowState,
  ClaudeLoginState,
  ConnectorAuthPush,
} from '@shared/models'
import type { RpcCommand } from '@shared/rpc'
import { applyStartupAppearance } from './startup-appearance'

applyStartupAppearance(process.argv)

/**
 * Listen on a push channel until the returned function is called.
 *
 * Every `on*` method below is this same four-line dance — attach a wrapper that
 * drops Electron's event argument, hand back a matching `removeListener`. The
 * wrapper identity is what makes unsubscribe work, so it has to be captured per
 * subscription rather than shared.
 */
function subscribe<A extends unknown[]>(
  channel: string,
  listener: (...args: A) => void,
): () => void {
  const wrapped = (_event: Electron.IpcRendererEvent, ...args: A): void => listener(...args)
  ipcRenderer.on(channel, wrapped)
  return () => ipcRenderer.removeListener(channel, wrapped)
}

const api: PhosphorApi = {
  // A sandboxed preload still gets `process.platform` from Electron's polyfill.
  platform:
    process.platform === 'darwin' ? 'darwin' : process.platform === 'win32' ? 'win32' : 'linux',

  invoke<C extends IpcInvokeChannel>(channel: C, ...args: IpcInvokeMap[C]['args']) {
    return ipcRenderer.invoke(channel, ...args) as Promise<IpcInvokeMap[C]['result']>
  },

  onSessionPush: (sessionId, listener) =>
    subscribe<[SessionPush]>(sessionEventChannel(sessionId), listener),

  onSessionsChanged: (listener) =>
    subscribe<[{ workspacePath: string }]>('sessions:changed', listener),

  onFsChanged: (listener) =>
    subscribe<[{ workspacePath: string; paths: string[] }]>('fs:changed', listener),

  onPackagesJobOutput: (jobId, listener) =>
    subscribe<[string]>(`packages:output:${jobId}`, listener),

  onPackagesJobExit: (jobId, listener) => subscribe<[number]>(`packages:exit:${jobId}`, listener),

  onPtyData: (ptyId, listener) => subscribe<[string]>(`pty:data:${ptyId}`, listener),

  onPtyExit: (ptyId, listener) => subscribe<[number]>(`pty:exit:${ptyId}`, listener),

  onUpdateEvent: (listener) => subscribe<[UpdateState]>('updates:event', listener),

  onMcpAuthState: (listener) => subscribe<[ConnectorAuthPush]>('mcp:authState', listener),

  onPiLoginState: (listener) => subscribe<[LoginFlowState]>('pi:loginState', listener),

  onClaudeLoginState: (listener) => subscribe<[ClaudeLoginState]>('claude:loginState', listener),

  onPtyStatus: (listener) => subscribe<[Record<string, boolean>]>('pty:status', listener),

  piCommand(sessionId: string, command: RpcCommand) {
    return ipcRenderer.invoke('pi:command', sessionId, command)
  },

  /**
   * Absolute path of a dropped/picked File. The sandboxed renderer cannot read
   * `File.path` (removed in Electron 32+), and non-image attachments are sent
   * to pi BY PATH — pi's protocol carries images only, so a PDF has to be
   * something the agent opens itself. Returns '' for files not backed by disk.
   */
  pathForFile(file: File) {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return ''
    }
  },
}

contextBridge.exposeInMainWorld('phosphor', api)
