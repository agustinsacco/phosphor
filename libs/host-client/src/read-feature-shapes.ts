import { parseFileParams, parseFileResult } from '@phosphor/shared/host-protocol-files'
import {
  machineRecord,
  parseMachineParams,
  parseMachineSkills,
  parseSkillReadResult,
  MACHINE_LIMITS,
} from '@phosphor/shared/host-protocol-machine'
import { utf8Length } from '@phosphor/shared/host-protocol'
import type { HostCapability } from '@phosphor/shared/remote-host'
import type { IpcInvokeChannel } from '@phosphor/shared/ipc'
import { REMOTE_UNAVAILABLE } from './lane-ops'

/** Opaque workspace keys are only labels. Paths sent to the Host are relative. */
function relativeReadPath(root: string, value: unknown): string {
  if (typeof value !== 'string' || !value.startsWith(`${root}/`))
    throw new Error(REMOTE_UNAVAILABLE)
  return value.slice(root.length + 1)
}

export function readFeatureRequest(
  channel: IpcInvokeChannel,
  args: unknown[],
  root: string,
  laneId?: string,
): { capability: HostCapability; method: string; params: unknown } {
  let method: string
  let params: unknown
  switch (channel) {
    case 'fs:listFiles':
      method = 'files.list'
      params = { laneId }
      break
    case 'fs:readFile':
      method = 'files.read'
      params = { laneId, path: relativeReadPath(root, args[0]) }
      break
    case 'git:statusMap':
      method = 'git.status'
      params = { laneId }
      break
    case 'git:showFileAt':
      method = 'git.show'
      params = { laneId, ref: args[1], path: args[2] }
      break
    case 'skills:list':
      method = 'skills.list'
      params = { laneId }
      break
    case 'skills:readFile': {
      const key = relativeReadPath(root, args[0])
      if (!key.startsWith('skill:')) throw new Error(REMOTE_UNAVAILABLE)
      method = 'skills.read'
      params = { laneId, name: key.slice(6), file: args[1] }
      break
    }
    default:
      throw new Error(REMOTE_UNAVAILABLE)
  }
  const files = method.startsWith('files.') || method.startsWith('git.')
  const parsed = files ? parseFileParams(method, params) : parseMachineParams(method, params)
  if (!parsed) throw new Error(REMOTE_UNAVAILABLE)
  return { capability: files ? 'workspaces.read' : 'skills.read', method, params: parsed }
}

function projectFileResult(
  channel: IpcInvokeChannel,
  method: string,
  args: unknown[],
  data: unknown,
): unknown {
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
      ...(!result.binary ? { revision: result.revision } : {}),
      size: result.size,
      mtimeMs: 0,
    }
  }
  throw new Error(REMOTE_UNAVAILABLE)
}

function projectSkillList(root: string, data: unknown) {
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
  throw new Error(REMOTE_UNAVAILABLE)
}

function projectSkillRead(data: unknown) {
  const result = parseSkillReadResult(data)
  if (result && (result.binary || utf8Length(result.content) <= MACHINE_LIMITS.textBytes))
    return {
      content: result.binary ? null : result.content,
      binary: result.binary,
      size: result.size,
    }
  throw new Error(REMOTE_UNAVAILABLE)
}

export function projectReadFeature(
  channel: IpcInvokeChannel,
  method: string,
  args: unknown[],
  root: string,
  data: unknown,
): unknown {
  if (method.startsWith('files.') || method.startsWith('git.'))
    return projectFileResult(channel, method, args, data)
  if (method === 'skills.list') return projectSkillList(root, data)
  return projectSkillRead(data)
}
