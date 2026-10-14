import { parseFileParams, parseFileResult } from '@shared/host-protocol-files'
import {
  machineRecord,
  parseMachineParams,
  parseMachineSkills,
  parseSkillReadResult,
  MACHINE_LIMITS,
} from '@shared/host-protocol-machine'
import { utf8Length } from '@shared/host-protocol'
import type { HostCapability } from '@shared/remote-host'
import type { IpcInvokeChannel } from '@shared/ipc'
import { REMOTE_UNAVAILABLE } from './lane-ops'

export interface ReadLane {
  laneId: string
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

/** Opaque workspace keys are only labels. Paths sent to the Host are relative. */
export async function readFeature(
  channel: IpcInvokeChannel,
  args: unknown[],
  lane: ReadLane,
): Promise<unknown> {
  const root = lane.workspacePath
  function relative(value: unknown): string {
    if (typeof value !== 'string' || !value.startsWith(`${root}/`))
      throw new Error(REMOTE_UNAVAILABLE)
    return value.slice(root.length + 1)
  }
  let method: string
  let params: unknown
  switch (channel) {
    case 'fs:listFiles':
      method = 'files.list'
      params = { laneId: lane.laneId }
      break
    case 'fs:readFile':
      method = 'files.read'
      params = { laneId: lane.laneId, path: relative(args[0]) }
      break
    case 'git:statusMap':
      method = 'git.status'
      params = { laneId: lane.laneId }
      break
    case 'git:showFileAt':
      method = 'git.show'
      params = { laneId: lane.laneId, ref: args[1], path: args[2] }
      break
    case 'skills:list':
      method = 'skills.list'
      params = { laneId: lane.laneId }
      break
    case 'skills:readFile': {
      const key = relative(args[0])
      if (!key.startsWith('skill:')) throw new Error(REMOTE_UNAVAILABLE)
      method = 'skills.read'
      params = { laneId: lane.laneId, name: key.slice(6), file: args[1] }
      break
    }
    default:
      throw new Error(REMOTE_UNAVAILABLE)
  }
  const files = method.startsWith('files.') || method.startsWith('git.')
  const parsed = files ? parseFileParams(method, params) : parseMachineParams(method, params)
  if (!parsed) throw new Error(REMOTE_UNAVAILABLE)
  let data: unknown
  try {
    data = await lane.call(files ? 'workspaces.read' : 'skills.read', method, parsed)
  } catch (error) {
    if (channel === 'fs:readFile' && error instanceof Error && error.message === 'too-large')
      return { path: args[0], content: '', size: 0, mtimeMs: 0, tooLarge: true }
    // No error-derived fields cross IPC. Undefined fails the result parser below.
  }
  if (files) {
    const result = parseFileResult(method, data)
    if (!result) throw new Error(REMOTE_UNAVAILABLE)
    if ('files' in result) return result.files
    if ('status' in result) return result.status
    if ('binary' in result) {
      if (channel === 'git:showFileAt') return result.binary ? null : result.content
      return {
        path: args[0],
        content: result.binary ? '' : result.content,
        binary: result.binary,
        size: result.size,
        mtimeMs: 0,
      }
    }
  } else if (method === 'skills.list') {
    const skills = machineRecord(data) ? parseMachineSkills(data.skills) : null
    // The read parser accepts only canonical skill names. Do not expose unusable keys.
    if (skills && skills.every((s) => parseMachineParams('skills.read', { name: s.name })))
      return {
        skills: skills.map((s) => ({
          ...s,
          dir: `${root}/skill:${s.name}`,
          source: 'host',
          origin: 'top-level',
          writable: false,
          borrowed: false,
          draft: false,
          files: [{ path: 'SKILL.md', size: 0 }],
          totalSize: 0,
          warnings: [],
        })),
        probe: 'rpc',
        userRoot: root,
      }
  } else {
    const result = parseSkillReadResult(data)
    if (result && (result.binary || utf8Length(result.content) <= MACHINE_LIMITS.textBytes))
      return {
        content: result.binary ? null : result.content,
        binary: result.binary,
        size: result.size,
      }
  }
  throw new Error(REMOTE_UNAVAILABLE)
}
