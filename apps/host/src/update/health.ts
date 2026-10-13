import { join } from 'node:path'
import { atomicRecord, readBounded } from './files'
import { prepareStateDirectory } from '../lanes/state-dir'

export interface RunHealth {
  version: string
  pid: number
  startedAt: number
  acceptedAt: number
}
export function healthWriter(
  directory: string,
  uid: number | undefined,
  version: string,
  now: () => number,
) {
  const startedAt = now()
  let last = -Infinity
  return () => {
    const acceptedAt = now()
    if (acceptedAt - last < 60_000) return
    prepareStateDirectory(directory, uid)
    atomicRecord(
      join(directory, 'run.json'),
      { version, pid: process.pid, startedAt, acceptedAt },
      0o600,
    )
    last = acceptedAt
  }
}
export function readRunHealth(directory: string): RunHealth | null {
  try {
    const value: unknown = JSON.parse(readBounded(join(directory, 'run.json'), 1024))
    if (
      !value ||
      typeof value !== 'object' ||
      !('version' in value) ||
      typeof value.version !== 'string' ||
      value.version.length > 80 ||
      !('pid' in value) ||
      typeof value.pid !== 'number' ||
      !Number.isSafeInteger(value.pid) ||
      value.pid < 1 ||
      !('startedAt' in value) ||
      typeof value.startedAt !== 'number' ||
      !Number.isSafeInteger(value.startedAt) ||
      value.startedAt < 0 ||
      !('acceptedAt' in value) ||
      typeof value.acceptedAt !== 'number' ||
      !Number.isSafeInteger(value.acceptedAt) ||
      value.acceptedAt < value.startedAt
    )
      return null
    return {
      version: value.version,
      pid: value.pid,
      startedAt: value.startedAt,
      acceptedAt: value.acceptedAt,
    }
  } catch {
    return null
  }
}
