/**
 * Brings Desktop's Brain Agent conversation into the Host's reserved Brain lane once the move
 * has published (docs/brain-handover.md). Every sealed transcript lands in the lane's pi folder
 * under its own name: history byte for byte, and the one that continues with only its header's
 * `cwd` changed to the Host lane folder (pi resumes in the header's cwd, as for a lane move).
 * The binding that names it belongs to the agent lane's owner; this only asks it to bind.
 *
 * Running again is safe: an identical file is already imported, the same binding is already
 * made. A different file under the same name, a link, or a binding to another conversation
 * refuses rather than overwrite.
 */
import { createHash } from 'node:crypto'
import { isUuid } from '@phosphor/shared/control-api'
import { constants, createReadStream, lstatSync } from 'node:fs'
import { link, lstat, mkdir, open, realpath, rm, type FileHandle } from 'node:fs/promises'
import { join } from 'node:path'
import { errnoIs } from '@phosphor/session-runtime/fs-safety'
import { sessionDirForCwd } from '@phosphor/session-runtime/pi/pi-paths'
import type { BrainAgentTranscriptImporter } from './handlers'
import { syncDirectory } from './layout'

/**
 * The agent lane owner's stable binding (`createBrainAgentBinding(path)` in brain/agent): the
 * transcript the reserved lane resumes, by absolute path, or null before its first turn.
 */
export interface BrainAgentBindingPort {
  read(): string | null | Promise<string | null>
  bind(sessionFile: string | null): void | Promise<void>
}

export interface BrainAgentImportPorts {
  /** `piSessionsRoot(env)` of the Host's lanes. */
  readonly sessionsRoot: string
  readonly binding: BrainAgentBindingPort
}

export class AgentImportRefused extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'AgentImportRefused'
  }
}

const HEADER_BYTES = 64 * 1024

type Transcript = Parameters<BrainAgentTranscriptImporter>[0]['transcripts'][number]

/** The header line, its parsed fields and where the rest of the file starts. */
async function readHeader(path: string): Promise<{ raw: Record<string, unknown>; end: number }> {
  const handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW)
  try {
    const buffer = Buffer.alloc(HEADER_BYTES)
    const { bytesRead } = await handle.read(buffer, 0, HEADER_BYTES, 0)
    const end = buffer.subarray(0, bytesRead).indexOf(0x0a)
    if (end > 0) {
      const raw: unknown = JSON.parse(buffer.subarray(0, end).toString('utf8'))
      if (raw && typeof raw === 'object' && (raw as { type?: unknown }).type === 'session')
        return { raw: raw as Record<string, unknown>, end: end + 1 }
    }
  } catch {
    // Refused below.
  } finally {
    await handle.close()
  }
  throw new AgentImportRefused('A Brain Agent transcript has no session header.')
}

/** The bytes the lane's copy holds: the sealed file, or its header with `cwd` replaced. */
interface Plan {
  readonly source: string
  /** Replaces bytes [0, from) of the source; absent copies it whole. */
  readonly header?: Buffer
  readonly from: number
}

async function* bytesOf(plan: Plan): AsyncGenerator<Buffer> {
  if (plan.header) yield plan.header
  for await (const chunk of createReadStream(plan.source, { start: plan.from }))
    yield chunk as Buffer
}

async function digest(chunks: AsyncIterable<Buffer>): Promise<string> {
  const hash = createHash('sha256')
  for await (const chunk of chunks) hash.update(chunk)
  return hash.digest('hex')
}

async function plan(transcript: Transcript, cwd: string | null): Promise<Plan> {
  const header = await readHeader(transcript.path)
  if (header.raw.id !== transcript.sessionId)
    throw new AgentImportRefused('A sealed transcript is not the verified conversation.')
  if ((await digest(bytesOf({ source: transcript.path, from: 0 }))) !== transcript.sha256)
    throw new AgentImportRefused('A sealed transcript changed after it was verified.')
  if (cwd === null) return { source: transcript.path, from: 0 }
  // Same key order, same id: only where the conversation runs changes.
  const line = `${JSON.stringify({ ...header.raw, cwd })}\n`
  return { source: transcript.path, header: Buffer.from(line, 'utf8'), from: header.end }
}

/** The digest of a regular, singly linked file at `path`; null when nothing is there. */
async function existing(path: string): Promise<string | null> {
  let handle: FileHandle
  try {
    handle = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  } catch (error) {
    if (errnoIs(error, 'ENOENT')) return null
    return 'not a regular file'
  }
  try {
    const info = await handle.stat()
    if (!info.isFile() || info.nlink !== 1) return 'not a regular file'
    return await digest(handle.createReadStream({ autoClose: false }))
  } finally {
    await handle.close()
  }
}

/** A killed writer may leave its private name before or after the no-replace link. */
async function recoverTemporary(temp: string, target: string): Promise<void> {
  const staged = await lstat(temp, { bigint: true }).catch((error: unknown) => {
    if (errnoIs(error, 'ENOENT')) return null
    throw error
  })
  if (!staged) return
  if (!staged.isFile()) throw new AgentImportRefused('The transcript staging name is not a file.')
  if (staged.nlink === 2n) {
    const dest = await lstat(target, { bigint: true })
    if (!dest.isFile() || dest.dev !== staged.dev || dest.ino !== staged.ino)
      throw new AgentImportRefused('The transcript staging link does not match its destination.')
  } else if (staged.nlink !== 1n) {
    throw new AgentImportRefused('The transcript staging file has unexpected links.')
  }
  // Removes only the move's private name. place() still verifies any target before accepting it.
  await rm(temp)
}

/** Writes `plan` beside `target` and links it in; a name that exists is never replaced. */
async function place(
  directory: string,
  name: string,
  bytes: Plan,
  migrationId: string,
): Promise<void> {
  const target = join(directory, name)
  const temp = join(
    directory,
    `.import-${migrationId}-${createHash('sha256').update(name).digest('hex')}`,
  )
  const expected = await digest(bytesOf(bytes))
  await recoverTemporary(temp, target)
  const found = await existing(target)
  if (found === expected) return
  if (found !== null)
    throw new AgentImportRefused(`The Brain lane already holds a different ${name}.`)
  try {
    const out = await open(temp, 'wx', 0o600)
    try {
      for await (const chunk of bytesOf(bytes)) await out.write(chunk)
      await out.sync()
    } finally {
      await out.close()
    }
    if ((await digest(createReadStream(temp))) !== expected)
      throw new AgentImportRefused(`The imported ${name} did not match.`)
    try {
      await link(temp, target)
    } catch (error) {
      if (!errnoIs(error, 'EEXIST')) throw error
      if ((await existing(target)) !== expected)
        throw new AgentImportRefused(`The Brain lane already holds a different ${name}.`)
    }
  } finally {
    await rm(temp, { force: true })
  }
}

/** The lane folder and its pi transcript folder, both real folders, never links. */
async function laneFolders(laneFolder: string, sessionsRoot: string) {
  await mkdir(laneFolder, { recursive: true, mode: 0o700 })
  const folder = await realpath(laneFolder)
  const directory = sessionDirForCwd(folder, sessionsRoot)
  await mkdir(directory, { recursive: true, mode: 0o700 })
  for (const path of [folder, directory]) {
    const info = await lstat(path)
    if (!info.isDirectory() || info.isSymbolicLink())
      throw new AgentImportRefused('The Brain lane’s folder is not a plain folder.')
  }
  return { folder, directory }
}

export function createBrainAgentTranscriptImport(
  ports: BrainAgentImportPorts,
): BrainAgentTranscriptImporter {
  return async (input) => {
    if (!isUuid(input.migrationId)) throw new AgentImportRefused('Invalid move identity.')
    const names = input.transcripts.map((t) => t.name)
    if (names.some((name) => !/^[A-Za-z0-9_][A-Za-z0-9._-]*\.jsonl$/.test(name)))
      throw new AgentImportRefused('A Brain Agent transcript has an unusable name.')
    if (input.active !== null && !names.includes(input.active))
      throw new AgentImportRefused('The conversation that continues was not sealed.')
    const { folder, directory } = await laneFolders(input.laneFolder, ports.sessionsRoot)
    const target = input.active === null ? null : join(directory, input.active)
    const current = await ports.binding.read()
    if (current !== null && current !== target)
      throw new AgentImportRefused('The Brain lane already has a conversation.')
    for (const transcript of input.transcripts)
      await place(
        directory,
        transcript.name,
        await plan(transcript, transcript.name === input.active ? folder : null),
        input.migrationId,
      )
    syncDirectory(directory)
    if (target !== null && current !== target) {
      if (!lstatSync(target).isFile()) throw new AgentImportRefused('The bound file is missing.')
      await ports.binding.bind(target)
    }
    return { bound: target }
  }
}
