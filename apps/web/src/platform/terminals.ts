import type { IpcInvokeMap } from '@phosphor/shared/ipc'
import { REMOTE_UNAVAILABLE } from '@phosphor/host-client/lane-ops'
import type { RemoteLanes } from '@phosphor/host-client/remote-lanes'
import { createRemoteTerminals } from '@phosphor/host-client/terminals/terminals'
import type { BrowserControl } from './control'
import type { createBrowserEvents } from './events'
import type { BrowserHosts } from './hosts'

type PtyChannel = 'pty:create' | 'pty:attach' | 'pty:write' | 'pty:resize' | 'pty:kill'
/** The browser is one window: the shared bridge's window id is always this one. */
const WINDOW = 1

/**
 * Host shells in the browser: lane terminals and the Machine page's shell, over
 * the same bridge Desktop's main process runs. Output reaches the UI on the
 * event names the PWA's `onPtyData` / `onPtyExit` listen on.
 */
export function createBrowserTerminals(ports: {
  hosts: Pick<BrowserHosts, 'connection'>
  lanes: Pick<RemoteLanes, 'terminalLane'>
  control: Pick<BrowserControl, 'session'>
  events: Pick<ReturnType<typeof createBrowserEvents>, 'emit'>
}) {
  const bridge = createRemoteTerminals({
    connection: ports.hosts.connection,
    lane: (windowId, sessionId, workspace) =>
      ports.lanes.terminalLane(windowId, sessionId, workspace),
    clientId: () => ports.control.session()?.clientId ?? null,
    emit: (_windowId, channel, value) =>
      ports.events.emit(channel.replace(/^pty:(data|exit):/, 'pty-$1:'), value),
  })
  function route<C extends PtyChannel>(channel: C) {
    return (...args: IpcInvokeMap[C]['args']) => {
      const routed = bridge.route(WINDOW, channel, args)
      if (!routed) throw new Error(REMOTE_UNAVAILABLE)
      return routed.result as Promise<IpcInvokeMap[C]['result']>
    }
  }
  return {
    reconcile: bridge.reconcile,
    /** Sign-out or dispose: detach every shell. Machine shells keep running on the Host. */
    clear: () => bridge.clear(),
    handlers: {
      'pty:create': route('pty:create'),
      'pty:attach': route('pty:attach'),
      'pty:write': route('pty:write'),
      'pty:resize': route('pty:resize'),
      'pty:kill': route('pty:kill'),
      'hosts:machineShell': (hostId: string, cols: number, rows: number) =>
        bridge.shell(WINDOW, hostId, cols, rows),
      /** Provider sign-in runs in a private Host terminal; configuring accounts needs Desktop. */
      'hosts:providerLogin': (...args: IpcInvokeMap['hosts:providerLogin']['args']) =>
        bridge.signIn(WINDOW, ...args),
    },
  }
}
