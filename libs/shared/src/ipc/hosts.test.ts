import { expectTypeOf, it } from 'vitest'
import type { IpcInvokeMap, HostsSnapshot, TrafficPage, RemoteLaneCreate } from '../ipc'
import type { FileRead } from '../host-protocol-files'
import type { TailscaleStatus } from '../tailscale-status'
import type { MachineClaude, MachineModel, MachineProvider } from '../host-protocol-machine'
import type { SkillsListResult } from '../skills'
import type { LiveSessionInfo } from '../models'
export interface BaselineHostsInvokeMap {
  'hosts:tailscaleStatus': { args: []; result: TailscaleStatus }

  // Read-only machine catalogues, independent of an open lane.
  'hosts:models': { args: [hostId: string]; result: MachineModel[] }

  'hosts:claude': {
    args: [hostId: string]
    /** null: unavailable, or a Host older than machine.claude. */
    result: MachineClaude | null
  }

  'hosts:providers': { args: [hostId: string]; result: MachineProvider[] }

  'hosts:repositoryFiles': { args: [hostId: string, repositoryId: string]; result: string[] }

  'hosts:repositoryFile': {
    args: [hostId: string, repositoryId: string, path: string]
    result: FileRead
  }

  'hosts:skills': { args: [hostId: string]; result: SkillsListResult }

  'hosts:providerLogin': { args: [hostId: string, provider: string]; result: { ptyId: string } }

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
