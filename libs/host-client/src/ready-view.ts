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
  | 'laneRename'
  | 'partialModels'
  | 'warmOnOpen'
  | 'laneArchive'
  | 'laneTransfer'
  | 'fileBytes'
  | 'prStatus'
  | 'webPushKey'
  | 'prTracking'
  | 'ops'
  | 'ownerLocal'
  | 'laneEditing'
  | 'laneContext'
  | 'laneReload'
  | 'sandboxes'
  | 'folderDirectives'
  | 'configFiles'
  | 'pagedLanes'
  | 'brain'
  | 'brainAccess'
  | 'capabilities'
>

/**
 * Project only the verified handshake's reviewed connection metadata. `local`:
 * the connection is this machine's own socket, the only place `ownerLocal` means
 * anything; a Host over the tailnet never gets it, whatever its frame says.
 */
export function readyView(frame: Extract<HostFrame, { type: 'ready' }>, local = false): ReadyView {
  return {
    state: 'ready',
    lastError: undefined,
    hostVersion: frame.hello.hostVersion,
    configurationSupported: frame.settings === true,
    machineShell: frame.machineShell === true,
    laneMarks: frame.laneMarks === true,
    laneRename: frame.laneRename === true,
    partialModels: frame.partialModels === true,
    warmOnOpen: frame.warmOnOpen === true,
    laneArchive: frame.laneArchive === true,
    laneTransfer: frame.laneTransfer === true,
    fileBytes: frame.fileBytes === true,
    prStatus: frame.prStatus === true,
    // Set even when absent, so a reconnect to an older Host forgets the key.
    webPushKey: frame.webPushKey,
    prTracking: frame.prTracking === true,
    ops: frame.ops === true,
    laneEditing: frame.laneEditing === true,
    laneContext: frame.laneContext === true,
    laneReload: frame.laneReload === true,
    sandboxes: frame.sandboxes === true,
    folderDirectives: frame.folderDirectives === true,
    configFiles: frame.configFiles === true,
    brain: frame.brain === true,
    brainAccess: frame.brain === true ? [...(frame.brainAccess ?? [])] : [],
    pagedLanes: frame.pagedLanes === true,
    ...(local ? { ownerLocal: frame.ownerLocal === true } : {}),
    capabilities: [...frame.capabilities],
  }
}
