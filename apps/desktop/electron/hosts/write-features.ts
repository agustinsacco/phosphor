import { parseFileWriteOp, parseWriteResult, type FileWriteOp } from '@shared/host-protocol-writes'
import type { IpcInvokeChannel } from '@shared/ipc'
import type { ReadLane } from './read-features'
import { REMOTE_UNAVAILABLE } from './lane-ops'

export interface WriteLane extends ReadLane {
  write(op: FileWriteOp): Promise<unknown>
}
export const WRITE_CHANNELS = new Set<IpcInvokeChannel>([
  'fs:writeFile',
  'fs:createFile',
  'fs:createDir',
  'fs:rename',
  'fs:trash',
  'fs:transfer',
])
export function routeRemoteWrite(
  channel: IpcInvokeChannel,
  args: unknown[],
  laneFor: (key: string) => WriteLane | null,
): { result: Promise<unknown> } | null {
  const key = args[0]
  if (!WRITE_CHANNELS.has(channel) || typeof key !== 'string' || !key.startsWith('host:'))
    return null
  const lane = laneFor(key)
  if (!lane) throw new Error(REMOTE_UNAVAILABLE)
  return { result: writeFeature(channel, args, lane) }
}
export async function writeFeature(
  channel: IpcInvokeChannel,
  args: unknown[],
  lane: WriteLane,
): Promise<unknown> {
  function path(value: unknown, root = false): string {
    if (root && value === lane.workspacePath) return '.'
    if (typeof value !== 'string' || !value.startsWith(`${lane.workspacePath}/`))
      throw new Error(REMOTE_UNAVAILABLE)
    return value.slice(lane.workspacePath.length + 1)
  }
  let input: unknown
  switch (channel) {
    case 'fs:writeFile':
      input = { type: 'files.write', path: path(args[0]), content: args[1], expected: args[2] }
      break
    case 'fs:createFile':
    case 'fs:createDir':
      input = {
        type: 'files.create',
        path: path(args[0]),
        kind: channel === 'fs:createDir' ? 'directory' : 'file',
      }
      break
    case 'fs:rename':
      input = { type: 'files.rename', from: path(args[0]), to: path(args[1]) }
      break
    case 'fs:trash':
      input = { type: 'files.delete', path: path(args[0]) }
      break
    case 'fs:transfer':
      input = {
        type: 'files.transfer',
        source: path(args[1]),
        directory: path(args[2], true),
        mode: args[3],
      }
      break
    default:
      throw new Error(REMOTE_UNAVAILABLE)
  }
  const op = parseFileWriteOp(input)
  if (!op) throw new Error(REMOTE_UNAVAILABLE)
  const data = await lane.write(op)
  if (op.type === 'files.write' || op.type === 'files.transfer') {
    const result = parseWriteResult(data)
    if (!result) throw new Error(REMOTE_UNAVAILABLE)
    if (op.type === 'files.transfer' && 'path' in result)
      return `${lane.workspacePath}/${result.path}`
    if (op.type === 'files.write' && 'revision' in result) return result
    throw new Error(REMOTE_UNAVAILABLE)
  }
  if (data !== undefined) throw new Error(REMOTE_UNAVAILABLE)
}
