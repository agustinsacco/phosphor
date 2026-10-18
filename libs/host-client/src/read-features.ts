import type { SkillsListResult } from '@phosphor/shared/skills'
import type { HostCapability } from '@phosphor/shared/remote-host'
import type { IpcInvokeChannel } from '@phosphor/shared/ipc'
import { REMOTE_UNAVAILABLE } from './lane-ops'
import { readFeatureRequest, projectReadFeature } from './read-feature-shapes'

export interface ReadLane {
  laneId?: string
  workspacePath: string
  call: (capability: HostCapability, method: string, params: unknown) => Promise<unknown>
}
export const READ_CHANNELS = new Set<IpcInvokeChannel>([
  'fs:listFiles',
  'fs:readFile',
  'git:statusMap',
  'git:showFileAt',
  'skills:list',
  'skills:readFile',
])

/**
 * Only a call naming a `host:` workspace goes to a Host. A call with no workspace
 * (a global catalogue, the app's own skills) stays local even while a remote lane
 * is focused.
 */
export function routeRemoteRead(
  channel: IpcInvokeChannel,
  args: unknown[],
  readLane: (key: string) => ReadLane | null,
): { result: Promise<unknown> } | null {
  const key = args[0]
  if (!READ_CHANNELS.has(channel) || typeof key !== 'string' || !key.startsWith('host:'))
    return null
  const lane = readLane(key)
  if (!lane) throw new Error(REMOTE_UNAVAILABLE)
  return { result: readFeature(channel, args, lane) }
}

export function readFeature(
  channel: 'skills:list',
  args: unknown[],
  lane: ReadLane,
): Promise<SkillsListResult>
export function readFeature(
  channel: IpcInvokeChannel,
  args: unknown[],
  lane: ReadLane,
): Promise<unknown>
export async function readFeature(
  channel: IpcInvokeChannel,
  args: unknown[],
  lane: ReadLane,
): Promise<unknown> {
  const root = lane.workspacePath
  const { capability, method, params } = readFeatureRequest(channel, args, root, lane.laneId)
  let data: unknown
  try {
    data = await lane.call(capability, method, params)
  } catch (error) {
    if (channel === 'fs:readFile' && error instanceof Error && error.message === 'too-large')
      return { path: args[0], content: '', size: 0, mtimeMs: 0, tooLarge: true }
    // No error-derived fields cross IPC. Undefined fails the result parser below.
  }
  return projectReadFeature(channel, method, args, root, data)
}
