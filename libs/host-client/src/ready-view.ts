import type { HostFrame } from '@phosphor/shared/host-protocol'
import type { HostConnectionView } from '@phosphor/shared/ipc'

type ReadyView = Pick<
  HostConnectionView,
  | 'state'
  | 'lastError'
  | 'hostVersion'
  | 'configurationSupported'
  | 'machineShell'
  | 'capabilities'
>

/** Project only the verified handshake's reviewed connection metadata. */
export function readyView(frame: Extract<HostFrame, { type: 'ready' }>): ReadyView {
  return {
    state: 'ready',
    lastError: undefined,
    hostVersion: frame.hello.hostVersion,
    configurationSupported: frame.settings === true,
    machineShell: frame.machineShell === true,
    capabilities: [...frame.capabilities],
  }
}
