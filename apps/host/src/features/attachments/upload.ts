import { createHash, randomBytes } from 'node:crypto'
import {
  constants,
  openSync,
  closeSync,
  writeSync,
  fsyncSync,
  renameSync,
  fstatSync,
  futimesSync,
  readSync,
  rmSync,
} from 'node:fs'
import { dirname, join } from 'node:path'
import {
  ATTACHMENT_LIMITS as LIMIT,
  parseAttachmentOp,
  type AttachmentOp,
} from '@phosphor/shared/host-protocol-attachments'
import type { WriteOutcome } from '../writes'
import { refusal, type AttachmentOwner, type AttachmentState, type Upload } from './state'
import { directory, laneDirectory, discard, sweep } from './storage'
import { charge } from './quota'

function begin(
  state: AttachmentState,
  owner: AttachmentOwner,
  op: Extract<AttachmentOp, { type: 'attachments.begin' }>,
): WriteOutcome {
  if (
    [...state.uploads.values()].filter((u) => u.laneId === owner.laneId).length >= LIMIT.files ||
    !charge(state, owner.laneId, op.size)
  )
    return refusal
  const id = randomBytes(16).toString('hex')
  const path = join(laneDirectory(state.temporary, owner.laneId), id)
  const fd = openSync(path, 'wx', 0o600)
  closeSync(fd)
  state.uploads.set(id, {
    ...owner,
    path,
    name: op.name.replace(/[^a-zA-Z0-9._-]/g, '_'),
    size: op.size,
    received: 0,
    index: 0,
    started: state.now(),
    hash: createHash('sha256'),
  })
  return { ok: true, data: { uploadId: id } }
}
function chunk(upload: Upload, op: Extract<AttachmentOp, { type: 'attachments.chunk' }>) {
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
  return { ok: true } as const
}
function diskHash(upload: Upload, sha256: string) {
  const fd = openSync(upload.path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
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
    if (hash.digest('hex') !== sha256) throw new Error('digest')
    fsyncSync(fd)
  } finally {
    closeSync(fd)
  }
}
function commit(
  state: AttachmentState,
  owner: AttachmentOwner,
  upload: Upload,
  op: Extract<AttachmentOp, { type: 'attachments.commit' }>,
): WriteOutcome {
  if (upload.received !== upload.size || upload.hash.digest('hex') !== op.sha256)
    throw new Error('digest')
  // Rehash disk bytes as well, so same-user edits cannot bypass verification.
  diskHash(upload, op.sha256)
  const path = join(laneDirectory(state.root, owner.laneId), `${op.uploadId}-${upload.name}`)
  // The random id reserves the final name; never replace an existing destination.
  const reserve = openSync(path, 'wx', 0o600)
  closeSync(reserve)
  try {
    renameSync(upload.path, path)
  } catch (error) {
    rmSync(path, { force: true })
    throw error
  }
  state.uploads.delete(op.uploadId)
  return { ok: true, data: { path } }
}
export async function execute(
  state: AttachmentState,
  owner: AttachmentOwner,
  input: AttachmentOp,
): Promise<WriteOutcome> {
  const op = parseAttachmentOp(input)
  if (!op || !state.ports.laneExists(owner.laneId)) return refusal
  let upload: Upload | undefined
  try {
    sweep(state)
    if (op.type === 'attachments.begin') return begin(state, owner, op)
    upload = state.uploads.get(op.uploadId)
    if (
      !upload ||
      upload.laneId !== owner.laneId ||
      upload.clientId !== owner.clientId ||
      upload.fence !== owner.fence
    )
      return refusal
    directory(dirname(upload.path))
    if (op.type === 'attachments.chunk') return chunk(upload, op)
    return commit(state, owner, upload, op)
  } catch {
    if (upload && 'uploadId' in op) discard(state, op.uploadId, upload)
    return refusal
  }
}
