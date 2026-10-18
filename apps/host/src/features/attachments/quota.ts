import { randomBytes } from 'node:crypto'
import {
  constants,
  existsSync,
  openSync,
  closeSync,
  writeSync,
  fsyncSync,
  readFileSync,
  renameSync,
  fstatSync,
  rmSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import { ATTACHMENT_LIMITS as LIMIT } from '@phosphor/shared/host-protocol-attachments'
import { errnoIs } from '../../fs-safety'
import { laneIdPattern, type AttachmentState } from './state'
import { laneDirectory } from './storage'

interface Bucket {
  minute: number
  bytes: number
}
function decodeLedger(value: unknown): Bucket[] {
  if (!Array.isArray(value) || value.length !== 61) throw new Error('quota')
  const buckets: Bucket[] = []
  for (const item of value) {
    if (
      typeof item !== 'object' ||
      item === null ||
      Object.keys(item).length !== 2 ||
      !('minute' in item) ||
      typeof item.minute !== 'number' ||
      !Number.isSafeInteger(item.minute) ||
      !('bytes' in item) ||
      typeof item.bytes !== 'number' ||
      !Number.isSafeInteger(item.bytes) ||
      item.bytes < 0 ||
      item.bytes > LIMIT.hourlyBytes ||
      buckets.some((b) => b.minute === item.minute)
    )
      throw new Error('quota')
    buckets.push({ minute: item.minute, bytes: item.bytes })
  }
  return buckets
}
function readLedger(path: string, prior: boolean, minute: number): Bucket[] {
  try {
    const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const stat = fstatSync(fd)
      if (!stat.isFile() || stat.size > 8192 || stat.mode & 0o077) throw new Error('quota')
      return decodeLedger(JSON.parse(readFileSync(fd, 'utf8')))
    } finally {
      closeSync(fd)
    }
  } catch (error) {
    // A missing ledger beside existing files is not a new lane.
    if (!(error instanceof Error && errnoIs(error, 'ENOENT')) || prior)
      return [{ minute, bytes: LIMIT.hourlyBytes }]
    return []
  }
}
function writeLedger(path: string, buckets: Bucket[]) {
  const temp = join(dirname(path), `.quota-${randomBytes(16).toString('hex')}`)
  let renamed = false
  try {
    const fd = openSync(temp, 'wx', 0o600)
    try {
      writeSync(fd, JSON.stringify(buckets))
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, path)
    renamed = true
  } finally {
    if (!renamed) rmSync(temp, { force: true })
  }
}
/** The partial minute plus sixty full minutes never undercount the rolling hour. */
export function charge(state: AttachmentState, laneId: string, bytes: number) {
  if (!laneIdPattern.test(laneId)) throw new Error('bad-request')
  const prior = existsSync(join(state.root, laneId))
  const path = join(laneDirectory(state.root, laneId), '.quota')
  let minute = Math.floor(state.now() / 60000)
  let buckets = readLedger(path, prior, minute)
  // Persist a monotonic minute: a backwards wall clock expires nothing.
  minute = Math.max(minute, ...buckets.map((b) => b.minute))
  buckets = buckets.filter((b) => b.minute >= minute - 60 && b.bytes > 0)
  const amount = Math.max(bytes, 64 * 1024)
  const allowed = buckets.reduce((sum, b) => sum + b.bytes, 0) + amount <= LIMIT.hourlyBytes
  if (allowed) {
    const bucket = buckets.find((b) => b.minute === minute)
    if (bucket) bucket.bytes += amount
    else buckets.push({ minute, bytes: amount })
  }
  while (buckets.length < 61) buckets.push({ minute: -1 - buckets.length, bytes: 0 })
  writeLedger(path, buckets)
  return allowed
}
