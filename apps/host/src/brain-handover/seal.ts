/**
 * Copies the files the owner staged into the Host's sealed folder, verifying each as it goes.
 * Only allowlisted names are read, each a regular file with one link and the owner's uid, through
 * no symlink, at exactly its declared size and hash. The Host checks and publishes these copies,
 * never the staged originals the owner can still write.
 */
import { createHash } from 'node:crypto'
import { constants, lstatSync } from 'node:fs'
import { mkdir, open, rm, type FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import {
  BRAIN_HANDOVER_LIMITS,
  isBrainHandoverName,
  type BrainHandoverFile,
} from '@phosphor/shared/host-protocol-owner'
import type { SealedFile } from './layout'

/** The pinned embedding model a moved copy must match file for file. */
export interface PinnedEmbeddingModel {
  readonly directoryName: string
  readonly files: readonly {
    readonly path: string
    readonly bytes: number
    readonly sha256: string
  }[]
}

export class SealRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'SealRefused'
  }
}

const CHUNK = 1024 * 1024

interface Destination {
  readonly path: string
  readonly cap: number
  readonly pinned?: string
}

function destination(name: string, model: PinnedEmbeddingModel | undefined): Destination | null {
  if (name === 'brain.sqlite')
    return { path: 'brain/brain.sqlite', cap: BRAIN_HANDOVER_LIMITS.databaseBytes }
  if (name === 'AGENTS.md')
    return { path: 'brain/Brain/AGENTS.md', cap: BRAIN_HANDOVER_LIMITS.rulesBytes }
  if (name.startsWith('transcripts/'))
    return { path: name, cap: BRAIN_HANDOVER_LIMITS.transcriptBytes }
  if (!model) return null
  const prefix = `embeddings/embedding-models/${model.directoryName}/`
  const file = model.files.find((f) => name === prefix + f.path)
  return file ? { path: `brain/${name}`, cap: file.bytes, pinned: file.sha256 } : null
}

/** Every folder from `stage` to the file's parent is a real folder, not a link. */
function checkAncestors(stage: string, name: string): void {
  const parts = name.split('/').slice(0, -1)
  let path = stage
  for (const part of ['', ...parts]) {
    path = part ? join(path, part) : path
    const info = lstatSync(path)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new SealRefused(`The staged ${name} is not in a plain folder.`)
  }
}

async function copyVerified(source: FileHandle, target: string, bytes: number): Promise<string> {
  await mkdir(dirname(target), { recursive: true, mode: 0o700 })
  const out = await open(target, 'wx', 0o600)
  const hash = createHash('sha256')
  const buffer = Buffer.alloc(CHUNK)
  let read = 0
  try {
    for (;;) {
      const { bytesRead } = await source.read(buffer, 0, CHUNK, read)
      if (bytesRead === 0) break
      read += bytesRead
      if (read > bytes) break
      hash.update(buffer.subarray(0, bytesRead))
      await out.write(buffer, 0, bytesRead)
    }
    await out.sync()
  } finally {
    await out.close()
  }
  if (read !== bytes) throw new SealRefused('A staged file changed size while it was copied.')
  return hash.digest('hex')
}

async function sealOne(
  stage: string,
  sealed: string,
  file: BrainHandoverFile,
  to: Destination,
  uid: number | undefined,
): Promise<SealedFile> {
  if (!isBrainHandoverName(file.name) || file.bytes > to.cap)
    throw new SealRefused(`The staged ${file.name} is not allowed.`)
  if (to.pinned !== undefined && to.pinned !== file.sha256)
    throw new SealRefused(`The staged ${file.name} is not the pinned model file.`)
  checkAncestors(stage, file.name)
  const flags = constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK
  let handle: FileHandle
  try {
    handle = await open(join(stage, file.name), flags)
  } catch {
    throw new SealRefused(`The staged ${file.name} is missing or a link.`)
  }
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.nlink !== 1 || (uid !== undefined && info.uid !== uid))
      throw new SealRefused(`The staged ${file.name} is not a private regular file.`)
    if (info.size !== file.bytes)
      throw new SealRefused(`The staged ${file.name} has the wrong size.`)
    const sha256 = await copyVerified(handle, join(sealed, to.path), file.bytes)
    if (sha256 !== file.sha256) throw new SealRefused(`The staged ${file.name} has the wrong hash.`)
    return { path: to.path, sha256, bytes: file.bytes }
  } finally {
    await handle.close()
  }
}

export interface SealResult {
  readonly sealed: readonly SealedFile[]
  readonly model: 'moved' | 'download-needed'
}

/**
 * Seals every allowlisted file. Embedding files the Host cannot pin are skipped, and a partial
 * model set is dropped: the Host then downloads its own copy.
 */
export async function sealStaged(input: {
  readonly stage: string
  readonly sealed: string
  readonly files: readonly BrainHandoverFile[]
  readonly uid: number | undefined
  readonly model?: PinnedEmbeddingModel
}): Promise<SealResult> {
  const stageInfo = lstatSync(input.stage)
  if (!stageInfo.isDirectory() || stageInfo.isSymbolicLink())
    throw new SealRefused('The staging folder is not a plain folder.')
  const sealed: SealedFile[] = []
  const model: SealedFile[] = []
  for (const file of input.files) {
    const to = destination(file.name, input.model)
    if (!to) {
      if (file.name.startsWith('embeddings/')) continue
      throw new SealRefused(`The staged ${file.name} is not allowed.`)
    }
    const done = await sealOne(input.stage, input.sealed, file, to, input.uid)
    ;(to.pinned ? model : sealed).push(done)
  }
  const complete = !!input.model && model.length === input.model.files.length
  if (!complete)
    await rm(join(input.sealed, 'brain', 'embeddings'), { recursive: true, force: true })
  return {
    sealed: complete ? [...sealed, ...model] : sealed,
    model: complete ? 'moved' : 'download-needed',
  }
}
