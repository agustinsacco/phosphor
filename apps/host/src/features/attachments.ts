import { createHash, randomBytes, type Hash } from 'node:crypto'
import {
  constants,
  lstatSync,
  existsSync,
  readdirSync,
  realpathSync,
  rmSync,
  openSync,
  closeSync,
  writeSync,
  fsyncSync,
  readFileSync,
  renameSync,
  fstatSync,
  futimesSync,
  readSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import {
  ATTACHMENT_LIMITS as LIMIT,
  parseAttachmentOp,
  attachmentId,
  type AttachmentOp,
} from '@phosphor/shared/host-protocol-attachments'
import type { WriteOutcome } from './writes'
import { prepareStateDirectory } from '../lanes/state-dir'

interface Owner {
  laneId: string
  clientId: string
  fence: number
}
interface Upload extends Owner {
  path: string
  name: string
  size: number
  received: number
  index: number
  started: number
  hash: Hash
}
interface Ports {
  directory: string
  laneExists(laneId: string): boolean
  log?: (event: string) => void
  now?: () => number
}
const laneIdPattern = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/
const refusal = { ok: false, code: 'bad-request' } as const

/** State directories are private, not a sandbox against the machine's owner.
 * Node has no portable openat; ancestor swaps by the same user remain possible.
 */
export function createAttachments(ports: Ports) {
  const now = ports.now ?? Date.now
  const root = join(ports.directory, 'attachments')
  const temporary = join(ports.directory, 'attachments-tmp')
  const uploads = new Map<string, Upload>()
  function directory(path: string) {
    prepareStateDirectory(path, process.getuid?.())
    if (realpathSync(path) !== path) throw new Error('unsafe-storage')
  }
  directory(root)
  directory(temporary)
  function laneDirectory(base: string, laneId: string) {
    if (!laneIdPattern.test(laneId)) throw new Error('bad-request')
    directory(base)
    const path = join(base, laneId)
    directory(path)
    return path
  }
  function discard(id: string, upload: Upload) {
    uploads.delete(id)
    try {
      for (const path of [temporary, dirname(upload.path)]) {
        const stat = lstatSync(path)
        if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path)
          throw new Error('unsafe-storage')
      }
      if (dirname(upload.path) !== join(temporary, upload.laneId)) throw new Error('unsafe-storage')
      rmSync(upload.path, { force: true })
    } catch {
      ports.log?.('attachments.cleanup-refused')
    }
  }
  function abort(laneId: string) {
    for (const [id, upload] of uploads) if (upload.laneId === laneId) discard(id, upload)
  }
  function remove(laneId: string) {
    if (!laneIdPattern.test(laneId)) return
    abort(laneId)
    for (const base of [root, temporary]) {
      directory(base)
      // rm does not follow symbolic links, including links inside a directory.
      rmSync(join(base, laneId), { recursive: true, force: true })
    }
  }
  function sweep() {
    for (const [id, upload] of uploads)
      if (now() - upload.started >= LIMIT.lifetimeMs || !ports.laneExists(upload.laneId))
        discard(id, upload)
    for (const base of [root, temporary]) {
      directory(base)
      for (const laneId of readdirSync(base)) {
        const path = join(base, laneId)
        const info = lstatSync(path)
        if (!laneIdPattern.test(laneId) || !info.isDirectory() || info.isSymbolicLink()) continue
        if (!ports.laneExists(laneId)) {
          remove(laneId)
          continue
        }
        if (base !== temporary) continue
        for (const name of readdirSync(path)) {
          if (!attachmentId(name)) continue
          const file = join(path, name)
          const stat = lstatSync(file)
          if (stat.isFile() && !stat.isSymbolicLink() && now() - stat.mtimeMs >= LIMIT.lifetimeMs)
            rmSync(file)
        }
      }
    }
  }
  /** The partial minute plus sixty full minutes never undercount the rolling hour. */
  function charge(laneId: string, bytes: number) {
    if (!laneIdPattern.test(laneId)) throw new Error('bad-request')
    const prior = existsSync(join(root, laneId))
    const path = join(laneDirectory(root, laneId), '.quota')
    let minute = Math.floor(now() / 60000)
    let buckets: { minute: number; bytes: number }[] = []
    try {
      const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      try {
        const stat = fstatSync(fd)
        if (!stat.isFile() || stat.size > 8192 || stat.mode & 0o077) throw new Error('quota')
        const value: unknown = JSON.parse(readFileSync(fd, 'utf8'))
        if (!Array.isArray(value) || value.length !== 61) throw new Error('quota')
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
      } finally {
        closeSync(fd)
      }
    } catch (error) {
      if (!(error instanceof Error && 'code' in error && error.code === 'ENOENT'))
        buckets = [{ minute, bytes: LIMIT.hourlyBytes }]
      // A missing ledger beside existing files is not a new lane.
      else if (prior) buckets = [{ minute, bytes: LIMIT.hourlyBytes }]
    }
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
    return allowed
  }
  sweep()
  const timer = setInterval(() => {
    try {
      sweep()
    } catch {
      /* Retry without leaking filesystem errors. */
    }
  }, 60000)
  timer.unref()
  return {
    abort,
    remove,
    sweep,
    close() {
      clearInterval(timer)
      for (const [id, upload] of uploads) discard(id, upload)
    },
    async execute(owner: Owner, input: AttachmentOp): Promise<WriteOutcome> {
      const op = parseAttachmentOp(input)
      if (!op || !ports.laneExists(owner.laneId)) return refusal
      let upload: Upload | undefined
      try {
        sweep()
        if (op.type === 'attachments.begin') {
          if (
            [...uploads.values()].filter((u) => u.laneId === owner.laneId).length >= LIMIT.files ||
            !charge(owner.laneId, op.size)
          )
            return refusal
          const id = randomBytes(16).toString('hex')
          const path = join(laneDirectory(temporary, owner.laneId), id)
          const fd = openSync(path, 'wx', 0o600)
          closeSync(fd)
          uploads.set(id, {
            ...owner,
            path,
            name: op.name.replace(/[^a-zA-Z0-9._-]/g, '_'),
            size: op.size,
            received: 0,
            index: 0,
            started: now(),
            hash: createHash('sha256'),
          })
          return { ok: true, data: { uploadId: id } }
        }
        upload = uploads.get(op.uploadId)
        if (
          !upload ||
          upload.laneId !== owner.laneId ||
          upload.clientId !== owner.clientId ||
          upload.fence !== owner.fence
        )
          return refusal
        directory(dirname(upload.path))
        if (op.type === 'attachments.chunk') {
          const bytes = Buffer.from(op.data, 'base64')
          if (op.index !== upload.index || upload.received + bytes.length > upload.size)
            throw new Error('chunk')
          const fd = openSync(
            upload.path,
            constants.O_WRONLY | constants.O_APPEND | constants.O_NOFOLLOW | constants.O_NONBLOCK,
          )
          try {
            const stat = fstatSync(fd)
            if (!stat.isFile() || stat.size !== upload.received) throw new Error('file')
            let written = 0
            while (written < bytes.length) written += writeSync(fd, bytes, written)
            futimesSync(fd, upload.started / 1000, upload.started / 1000)
          } finally {
            closeSync(fd)
          }
          upload.hash.update(bytes)
          upload.received += bytes.length
          upload.index++
          return { ok: true }
        }
        if (upload.received !== upload.size || upload.hash.digest('hex') !== op.sha256)
          throw new Error('digest')
        // Rehash disk bytes as well, so same-user edits cannot bypass verification.
        const fd = openSync(
          upload.path,
          constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK,
        )
        try {
          const stat = fstatSync(fd)
          if (!stat.isFile() || stat.size !== upload.size) throw new Error('file')
          const hash = createHash('sha256')
          const buffer = Buffer.alloc(LIMIT.chunkBytes)
          let count = 0
          while (count < stat.size) {
            const n = readSync(fd, buffer, 0, Math.min(buffer.length, stat.size - count), count)
            if (!n) throw new Error('file')
            hash.update(buffer.subarray(0, n))
            count += n
          }
          if (hash.digest('hex') !== op.sha256) throw new Error('digest')
          fsyncSync(fd)
        } finally {
          closeSync(fd)
        }
        const path = join(laneDirectory(root, owner.laneId), `${op.uploadId}-${upload.name}`)
        // The random id reserves the final name; never replace an existing destination.
        const reserve = openSync(path, 'wx', 0o600)
        closeSync(reserve)
        try {
          renameSync(upload.path, path)
        } catch (error) {
          rmSync(path, { force: true })
          throw error
        }
        uploads.delete(op.uploadId)
        return { ok: true, data: { path } }
      } catch {
        if (upload && 'uploadId' in op) discard(op.uploadId, upload)
        return refusal
      }
    },
  }
}
export type HostAttachments = ReturnType<typeof createAttachments>
