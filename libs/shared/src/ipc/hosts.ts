import type { FileRead } from '../host-protocol-files'
import type { TailscaleStatus } from '../tailscale-status'
import type { MachineClaude, MachineModel, MachineProvider } from '../host-protocol-machine'
import type { SkillsListResult } from '../skills'
import type { RpcSlashCommand } from '../rpc'
import type { SkillBundle, SkillInstallResult } from '../host-protocol-skill-share'
import type { LaneMovePlan, LaneMoveRequest, LaneMoveResult } from '../lane-move'
import type {
  MachineSettings,
  MachineSettingsPatch,
  MachineSettingsSection,
  MachineTaskOp,
} from '../machine-settings'
import type { ProviderLoginOp } from '../host-protocol-providers'
import type { SubagentInspectRequest } from '../subagent-inspect'
import type { ClaudeUsageSnapshotResult, LiveSessionInfo } from '../models'
import type { HostsSnapshot, TrafficPage, RemoteLaneCreate } from './views'

export interface HostsInvokeMap {
  'hosts:tailscaleStatus': { args: []; result: TailscaleStatus }
  // Read-only machine catalogues, independent of an open lane.
  'hosts:models': { args: [hostId: string]; result: MachineModel[] }
  /** pi's `/` commands on the Host for one configured repository, so a new lane offers them. */
  'hosts:commands': { args: [hostId: string, repositoryId?: string]; result: RpcSlashCommand[] }
  'hosts:claude': {
    args: [hostId: string]
    /** null: unavailable, or a Host older than machine.claude. */
    result: MachineClaude | null
  }
  'hosts:claudeUsage': {
    args: [hostId: string, laneId?: string, force?: boolean]
    /** The lane's Claude account's plan usage on the Host. null: unavailable or an older Host. */
    result: ClaudeUsageSnapshotResult | null
  }
  'hosts:providers': { args: [hostId: string]; result: MachineProvider[] }
  'hosts:repositoryFiles': { args: [hostId: string, repositoryId: string]; result: string[] }
  'hosts:repositoryFile': {
    args: [hostId: string, repositoryId: string, path: string]
    result: FileRead
  }
  'hosts:skills': { args: [hostId: string]; result: SkillsListResult }
  /** One skill bundle to share. `machine` is 'local' or a Host id; This Mac needs `dir` from `skills:list`. */
  'hosts:skillExport': {
    args: [source: { machine: string; name: string; dir?: string }]
    result: SkillBundle
  }
  /** Copy a bundle into a machine's global skills folder; a Host needs configuration access. */
  'hosts:skillInstall': {
    args: [machine: string, bundle: SkillBundle, overwrite: boolean]
    result: SkillInstallResult
  }
  /** What moving a lane would do, or why it cannot. Reads only. */
  'hosts:laneMovePlan': { args: [request: LaneMoveRequest]; result: LaneMovePlan }
  /** Copy a stopped lane to another workspace or machine; the source is never changed. */
  'hosts:laneMove': { args: [request: LaneMoveRequest]; result: LaneMoveResult }
  'hosts:providerLogin': {
    args: [
      hostId: string,
      provider: string,
      account?: Pick<ProviderLoginOp, 'accountId' | 'addAccount' | 'configure'>,
    ]
    result: { ptyId: string }
  }
  'hosts:settingsAccess': { args: [hostId: string]; result: void }
  'hosts:settingsRead': {
    args: [hostId: string, section: MachineSettingsSection, repositoryId?: string]
    result: MachineSettings
  }
  'hosts:claudeAccount': { args: [hostId: string, laneId: string, accountId: string]; result: void }
  'hosts:settingsCheck': { args: [hostId: string, repositoryId?: string]; result: MachineSettings }
  'hosts:settingsPatch': {
    args: [hostId: string, patch: MachineSettingsPatch]
    result: MachineSettings
  }
  'hosts:machineTask': { args: [hostId: string, task: MachineTaskOp]; result: { ptyId: string } }
  /** The Host account's shell in its home folder; reattaches to a running one. */
  'hosts:machineShell': {
    args: [hostId: string, cols: number, rows: number]
    result: { ptyId: string }
  }
  'hosts:uploadAttachments': {
    args: [sessionId: string, files: { name: string; mime: string; data: string }[]]
    result: string[]
  }
  'hosts:snapshot': { args: []; result: HostsSnapshot }
  /** Drops and reopens one Host connection, after re-reading the directory. */
  'hosts:reconnect': { args: [hostId: string]; result: void }
  /** Memory-only traffic metadata recorded after `after` (0 for everything kept). */
  'hosts:traffic': { args: [after: number]; result: TrafficPage }
  'hosts:setFocusedLane': {
    args: [target: { hostId: string; laneId: string } | null]
    result: void
  }
  /** Opens a remote lane: returns an opaque handle (LiveSessionInfo.sessionId) whose
   * pi:command, pi:extensionUiResponse, pi:disposeSession and pi:event:<id> main routes
   * to the Host. Disposing a handle unsubscribes; it never stops the lane. */
  'hosts:openLane': { args: [hostId: string, laneId: string]; result: LiveSessionInfo }
  'hosts:createLane': { args: [hostId: string, input: RemoteLaneCreate]; result: LiveSessionInfo }
  'hosts:stopLane': { args: [hostId: string, laneId: string]; result: void }
  'hosts:resumeLane': { args: [hostId: string, laneId: string]; result: void }
  'hosts:takeControl': { args: [hostId: string, laneId: string]; result: void }
  'hosts:markRead': { args: [hostId: string, laneId: string]; result: void }
  /** A lane this window opened, exported by its Host as one HTML document. */
  'hosts:exportLaneHtml': { args: [sessionId: string]; result: { html: string } }
  /**
   * A lane this window opened: one of its files, by lane-relative path, saved into this
   * device's Downloads folder. `id` names the download for `onFileDownloadProgress` and
   * `hosts:fileDownloadCancel`; it rejects with fixed text, including when cancelled.
   */
  'hosts:fileDownload': {
    args: [request: { sessionId: string; path: string; id: string }]
    result: { savedTo: string }
  }
  'hosts:fileDownloadCancel': { args: [id: string]; result: void }
  /** A lane this window opened: its subagent records on the active branch, as its Host sends them. */
  'hosts:subagentHistory': {
    args: [sessionId: string]
    result: { entries: unknown[]; leafId: string | null }
  }
  /** A lane this window opened: its Host asks pi-subagents for one run, answered on the lane's widget. */
  'hosts:subagentInspect': {
    args: [sessionId: string, request: SubagentInspectRequest]
    result: null
  }
  'hosts:deleteLane': {
    args: [
      hostId: string,
      laneId: string,
      options: { removeWorktree: boolean; removeBranch: boolean },
    ]
    result: { branchKept: boolean }
  }
  'hosts:listFolders': {
    args: [hostId: string, path?: string, hidden?: boolean]
    result: {
      path: string
      truncated: boolean
      entries: { name: string; isRepository: boolean; configured: boolean }[]
    }
  }
  'hosts:addRepository': { args: [hostId: string, path: string]; result: { repositoryId: string } }
  'hosts:createFolder': { args: [hostId: string, path: string]; result: void }
  'hosts:removeRepository': { args: [hostId: string, repositoryId: string]; result: void }
  /** Every active repository id, in the order the Host should list them. */
  'hosts:orderRepositories': { args: [hostId: string, repositoryIds: string[]]; result: void }
  /** Pin or mark a Host lane on its Host. A null marker forgets the choice; '' is "none". */
  'hosts:setLaneMarks': {
    args: [hostId: string, laneId: string, marks: { pinned?: boolean; marker?: string | null }]
    result: void
  }
  'hosts:releaseControl': { args: [hostId: string, laneId: string]; result: void }
}
