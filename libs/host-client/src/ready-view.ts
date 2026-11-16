import type { HostFrame } from '@phosphor/shared/host-protocol'
import type { HostConnectionView } from '@phosphor/shared/ipc'

type ReadyView = Pick<
  HostConnectionView,
  | 'state'
  | 'lastError'
  | 'hostVersion'
  | 'configurationSupported'
  | 'machineShell'
  | 'laneMarks'
  | 'laneTransfer'
  | 'fileBytes'
  | 'prStatus'
  | 'webPushKey'
  | 'prTracking'
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
    laneMarks: frame.laneMarks === true,
    laneTransfer: frame.laneTransfer === true,
    fileBytes: frame.fileBytes === true,
    prStatus: frame.prStatus === true,
    // Set even when absent, so a reconnect to an older Host forgets the key.
    webPushKey: frame.webPushKey,
    prTracking: frame.prTracking === true,
    capabilities: [...frame.capabilities],
  }
}
