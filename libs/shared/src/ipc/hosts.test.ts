import { expectTypeOf, it } from 'vitest'
import type { IpcInvokeMap, HostsSnapshot, TrafficPage, RemoteLaneCreate } from '../ipc'
import type { FileRead } from '../host-protocol-files'
import type { TailscaleStatus } from '../tailscale-status'
import type { MachineClaude, MachineModel, MachineProvider } from '../host-protocol-machine'
import type { SkillsListResult } from '../skills'
import type { SkillBundle, SkillInstallResult } from '../host-protocol-skill-share'
import type { ClaudeUsageSnapshotResult, LiveSessionInfo } from '../models'
import type {
  MachineSettings,
  MachineSettingsPatch,
  MachineSettingsSection,
  MachineTaskOp,
} from '../machine-settings'
import type { ProviderLoginOp } from '../host-protocol-providers'
export interface BaselineHostsInvokeMap {
  'hosts:tailscaleStatus': { args: []; result: TailscaleStatus }

  // Read-only machine catalogues, independent of an open lane.
  'hosts:models': { args: [hostId: string]; result: MachineModel[] }

  'hosts:claude': {
    args: [hostId: string]
    /** null: unavailable, or a Host older than machine.claude. */
    result: MachineClaude | null
  }
  'hosts:claudeUsage': {
    args: [hostId: string, laneId?: string, force?: boolean]
    result: ClaudeUsageSnapshotResult | null
  }

  'hosts:providers': { args: [hostId: string]; result: MachineProvider[] }

  'hosts:repositoryFiles': { args: [hostId: string, repositoryId: string]; result: string[] }

  'hosts:repositoryFile': {
    args: [hostId: string, repositoryId: string, path: string]
    result: FileRead
  }

  'hosts:skills': { args: [hostId: string]; result: SkillsListResult }

  // Skill sharing: one bundle out of a machine, then into another's global skills folder.
  'hosts:skillExport': {
    args: [source: { machine: string; name: string; dir?: string }]
    result: SkillBundle
  }
  'hosts:skillInstall': {
    args: [machine: string, bundle: SkillBundle, overwrite: boolean]
    result: SkillInstallResult
  }

  'hosts:providerLogin': {
    args: [
      hostId: string,
      provider: string,
      account?: Pick<ProviderLoginOp, 'accountId' | 'addAccount' | 'configure'>,
    ]
    result: { ptyId: string }
  }

  // Reviewed additive machine-administration contract; all are explicit Host operations.
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
  'hosts:orderRepositories': { args: [hostId: string, repositoryIds: string[]]; result: void }
  'hosts:setLaneMarks': {
    args: [hostId: string, laneId: string, marks: { pinned?: boolean; marker?: string | null }]
    result: void
  }

  'hosts:releaseControl': { args: [hostId: string, laneId: string]; result: void }
}
it('freezes hosts channel tuples and results through ipc.ts', () => {
  expectTypeOf<
    Pick<IpcInvokeMap, keyof BaselineHostsInvokeMap>
  >().toEqualTypeOf<BaselineHostsInvokeMap>()
})

import type { HostsInvokeMap } from './hosts'

it('keeps hosts leaf exact and confined to its prefix', () => {
  expectTypeOf<HostsInvokeMap>().toEqualTypeOf<BaselineHostsInvokeMap>()
  expectTypeOf<keyof HostsInvokeMap>().toEqualTypeOf<
    Extract<keyof IpcInvokeMap, `hosts:${string}`>
  >()
})
