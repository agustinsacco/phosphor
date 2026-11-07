import { randomBytes, randomUUID } from 'node:crypto'
import {
  link,
  lstat,
  mkdir,
  readFile,
  rm,
  rmdir,
  unlink,
  utimes,
  writeFile,
} from 'node:fs/promises'
import { dirname, join } from 'node:path'
import type {
  LaneMoveNotice,
  LanePart,
  LaneTargetPlan,
} from '@phosphor/shared/host-protocol-lane-transfer'
import {
  claudeProjectDirForCwd,
  claudeProviderStateDir,
  piSessionsRoot,
  sessionDirForCwd,
} from '../pi/pi-paths'
import type { ArchiveReader } from './archive'
import type { MachinePaths } from './collect'
import { refuse, sha256File } from './files'
import { writeFileAtomic } from '../artifacts/artifact-indexer'
import { noticeEntry, noticeText } from './notice'
import { parseHeader, splitTranscript, transcriptFacts } from './transcript'

export interface InstallInput {
  archive: ArchiveReader
  plan: LaneTargetPlan
  /** The prepared folder the lane will run in. */
  cwd: string
  paths: MachinePaths
  labels: LaneMoveNotice
  /** Where copied attachments go, given the copy's session id. Null on the source's own machine, where the old paths still work. */
  attachmentsDir: ((sessionId: string) => string) | null
  /** Whether a pi session with this id already exists on this machine. */
  sessionTaken(sessionId: string): Promise<boolean>
  now?: () => Date
}

export interface InstalledLane {
  sessionFile: string
  sessionId: string
  undo(): Promise<void>
}

/** pi's own id shape: a v7 UUID, time-ordered like the ones it mints. */
export function uuidv7(now = Date.now()): string {
  const bytes = randomBytes(16)
  bytes.writeUIntBE(now, 0, 6)
  bytes[6] = (bytes[6]! & 0x0f) | 0x70
  bytes[8] = (bytes[8]! & 0x3f) | 0x80
  const hex = bytes.toString('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`
}

async function present(path: string): Promise<boolean> {
  try {
    await lstat(path)
    return true
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return false
    throw error
  }
}

/** Replace a header's `cwd` (and `id`) and drop a `parentSession` that names the old machine. */
function rewriteHeader(text: string, cwd: string, id?: string, onlyFrom?: string): string {
  const split = splitTranscript(text)
  const header = split && parseHeader(split.header)
  if (!split || !header || (onlyFrom !== undefined && header.cwd !== onlyFrom)) return text
  const raw: Record<string, unknown> = { ...header.raw, cwd, ...(id ? { id } : {}) }
  if (id) delete raw.parentSession
  return `${JSON.stringify(raw)}\n${split.rest}`
}

/** Rewrite a CLI transcript's `sessionId`, keeping lines it cannot parse as they were. */
function rewriteCli(text: string, from: string, to: string): string {
  if (from === to) return text
  return text
    .split('\n')
    .map((line) => {
      try {
        const entry = JSON.parse(line) as Record<string, unknown>
        if (entry.sessionId !== from) return line
        return JSON.stringify({ ...entry, sessionId: to })
      } catch {
        return line
      }
    })
    .join('\n')
}

async function readMap(mapPath: string): Promise<Record<string, unknown>> {
  try {
    const value = JSON.parse(await readFile(mapPath, 'utf8')) as unknown
    return value && typeof value === 'object' && !Array.isArray(value)
      ? (value as Record<string, unknown>)
      : {}
  } catch {
    return {}
  }
}

/** The names the lane takes here: its own ids unless this machine already uses them. */
async function landingIds(input: InstallInput) {
  const { manifest, paths, cwd } = { ...input, manifest: input.archive.manifest }
  const source = manifest.source
  const now = (input.now ?? (() => new Date()))()
  const reId = await input.sessionTaken(source.sessionId)
  const sessionId = reId ? uuidv7(now.getTime()) : source.sessionId
  const fileName = manifest.fileName.replace(source.sessionId, sessionId)
  const sessionDir = sessionDirForCwd(cwd, piSessionsRoot(paths.env, paths.home))
  const stateDir = claudeProviderStateDir(paths.env, paths.home)
  const mapPath = join(stateDir, 'session-map.json')
  const oldCli = manifest.claude?.cliSessionId ?? null
  const cliTaken = oldCli !== null && Object.values(await readMap(mapPath)).includes(oldCli)
  const cli = oldCli === null ? null : reId || cliTaken ? randomUUID() : oldCli
  const project = claudeProjectDirForCwd(cwd, paths.env, paths.home)
  const sessionFile = join(sessionDir, fileName)
  return {
    now,
    sessionId,
    fileName,
    sessionDir,
    sessionFile,
    stateDir,
    mapPath,
    oldCli,
    cli,
    project,
  }
}
type LandingIds = Awaited<ReturnType<typeof landingIds>>

function destination(input: InstallInput, ids: LandingIds, part: LanePart): string {
  switch (part.kind) {
    case 'transcript':
      return ids.sessionFile
    case 'runs':
      return join(ids.sessionFile.replace(/\.jsonl$/, ''), part.path)
    case 'subagent':
      return join(ids.sessionDir, 'subagent-artifacts', part.path)
    case 'claude-transcript':
      return join(ids.project, `${ids.cli}.jsonl`)
    case 'claude-sidecar':
      return join(ids.project, ids.cli!, part.path)
    case 'claude-prompt':
      return join(ids.stateDir, 'sysprompt', `${ids.cli}.txt`)
    case 'attachment':
      if (!input.attachmentsDir) refuse('The lane bundle is damaged.')
      return join(input.attachmentsDir(ids.sessionId), part.path)
  }
}

/** Where every part goes, refusing any that would replace a file already here. */
async function placeParts(input: InstallInput, ids: LandingIds) {
  const plan = input.archive.manifest.parts.map((part, index) => ({
    part,
    index,
    to: destination(input, ids, part),
  }))
  const skip = new Set<number>()
  for (const { part, index, to } of plan) {
    if (!(await present(to))) continue
    // Subagent artifacts are shared by a folder's lanes; an identical file is already here.
    if (part.kind === 'subagent' && (await sha256File(to).catch(() => '')) === part.sha256)
      skip.add(index)
    else refuse(`Part of this lane already exists on ${input.labels.to}. Nothing was changed.`)
  }
  return plan.filter(({ index }) => !skip.has(index))
}

/** Writes that never replace a file, and remember enough to take themselves back. */
function writer(ids: LandingIds) {
  const written: string[] = []
  const dirs = new Set<string>()
  let mapped = false
  const ensureDir = async (dir: string, mode?: number) => {
    for (let at = dir; ; at = dirname(at)) {
      const stat = await lstat(at).catch((error: NodeJS.ErrnoException) => {
        if (error.code !== 'ENOENT') throw error
        return null
      })
      if (stat && (!stat.isDirectory() || stat.isSymbolicLink()))
        refuse('A lane destination contains a symlink or is not a folder.')
      if (!stat) dirs.add(at)
      if (dirname(at) === at) break
    }
    await mkdir(dir, { recursive: true, ...(mode ? { mode } : {}) })
  }
  return {
    written,
    ensureDir,
    /** A private file (an attachment) also gets a private folder. */
    async put(to: string, bytes: Buffer | string, mode?: number) {
      await ensureDir(dirname(to), mode ? 0o700 : undefined)
      await writeFile(to, bytes, { flag: 'wx', ...(mode ? { mode } : {}) })
      written.push(to)
    },
    async pair() {
      const map = await readMap(ids.mapPath)
      map[ids.sessionId] = ids.cli
      await ensureDir(ids.stateDir)
      await writeFileAtomic(ids.mapPath, JSON.stringify(map, null, 2))
      mapped = true
    },
    async undo() {
      for (const path of [...written].reverse())
        await rm(path, { force: true }).catch(() => undefined)
      for (const dir of [...dirs].sort((a, b) => b.length - a.length))
        await rmdir(dir).catch(() => undefined)
      if (!mapped || !ids.cli) return
      const map = await readMap(ids.mapPath)
      if (map[ids.sessionId] !== ids.cli) return
      delete map[ids.sessionId]
      await writeFileAtomic(ids.mapPath, JSON.stringify(map, null, 2)).catch(() => undefined)
    },
  }
}
type Writer = ReturnType<typeof writer>

/** Every part but the transcript; returns where each attachment landed. */
async function writeParts(
  input: InstallInput,
  ids: LandingIds,
  out: Writer,
  plan: Awaited<ReturnType<typeof placeParts>>,
) {
  const moved: { from: string; to: string }[] = []
  for (const { part, index, to } of plan) {
    if (part.kind === 'transcript') continue
    const bytes = await input.archive.read(index)
    if (part.kind === 'runs' && part.path.endsWith('.jsonl'))
      await out.put(
        to,
        rewriteHeader(
          bytes.toString('utf8'),
          input.cwd,
          undefined,
          input.archive.manifest.source.cwd,
        ),
      )
    else if (part.kind === 'claude-transcript')
      await out.put(to, rewriteCli(bytes.toString('utf8'), ids.oldCli!, ids.cli!))
    else if (part.kind === 'attachment') {
      await out.put(to, bytes, 0o600)
      moved.push({ from: part.from!, to })
    } else await out.put(to, bytes)
  }
  return moved
}

/** The transcript, with its notice, goes last and all at once. */
async function publishTranscript(
  input: InstallInput,
  ids: LandingIds,
  out: Writer,
  moved: { from: string; to: string }[],
) {
  const { manifest } = input.archive
  const transcript = manifest.parts.findIndex((part) => part.kind === 'transcript')
  const raw = (await input.archive.read(transcript)).toString('utf8')
  // Only self-qualified artifact URLs change; prose and foreign artifact refs stay intact.
  const linked = raw.replaceAll(
    `artifact://${manifest.source.sessionId}/`,
    `artifact://${ids.sessionId}/`,
  )
  const text = rewriteHeader(linked, input.cwd, ids.sessionId)
  const split = splitTranscript(text)
  if (!split) refuse('The lane bundle is damaged.')
  const notice = noticeText({
    labels: input.labels,
    source: manifest.source,
    plan: input.plan,
    cwd: input.cwd,
    attachments: moved,
    at: ids.now,
  })
  const body = text.endsWith('\n') ? text : `${text}\n`
  const entry = noticeEntry(notice, transcriptFacts(split.rest).leafId, ids.now, moved)
  const temporary = join(ids.sessionDir, `.${ids.fileName}.${randomBytes(6).toString('hex')}.tmp`)
  await out.put(temporary, `${body}${entry}\n`)
  await utimes(temporary, ids.now, new Date(manifest.modifiedAt))
  // `link` refuses an existing name: a transcript that appeared meanwhile is never replaced.
  await link(temporary, ids.sessionFile)
  out.written.push(ids.sessionFile)
  await unlink(temporary)
  out.written.splice(out.written.indexOf(temporary), 1)
}

/**
 * Write a verified bundle into this machine. Every destination is checked
 * before the first write, the transcript is published last by an exclusive
 * link, and any failure removes what this call wrote. Nothing is overwritten.
 */
export async function installLane(input: InstallInput): Promise<InstalledLane> {
  const ids = await landingIds(input)
  const plan = await placeParts(input, ids)
  const out = writer(ids)
  try {
    const moved = await writeParts(input, ids, out, plan)
    if (ids.cli) await out.pair()
    await publishTranscript(input, ids, out, moved)
    return { sessionFile: ids.sessionFile, sessionId: ids.sessionId, undo: out.undo }
  } catch (error) {
    await out.undo()
    throw error
  }
}
