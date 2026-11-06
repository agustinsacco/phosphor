import { randomBytes, randomUUID } from 'node:crypto'
import { link, lstat, mkdir, readFile, rm, rmdir, unlink, utimes, writeFile } from 'node:fs/promises'
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

/**
 * Write a verified bundle into this machine. Every destination is checked
 * before the first write, the transcript is published last by an exclusive
 * link, and any failure removes what this call wrote. Nothing is overwritten.
 */
export async function installLane(input: InstallInput): Promise<InstalledLane> {
  const { archive, cwd, paths } = input
  const { manifest } = archive
  const source = manifest.source
  const now = (input.now ?? (() => new Date()))()
  const reId = await input.sessionTaken(source.sessionId)
  const sessionId = reId ? uuidv7(now.getTime()) : source.sessionId
  const fileName = manifest.fileName.replace(source.sessionId, sessionId)
  const sessionDir = sessionDirForCwd(cwd, piSessionsRoot(paths.env, paths.home))
  const sessionFile = join(sessionDir, fileName)
  const stateDir = claudeProviderStateDir(paths.env, paths.home)
  const mapPath = join(stateDir, 'session-map.json')
  const readMap = async (): Promise<Record<string, unknown>> => {
    try {
      const value = JSON.parse(await readFile(mapPath, 'utf8')) as unknown
      return value && typeof value === 'object' && !Array.isArray(value)
        ? (value as Record<string, unknown>)
        : {}
    } catch {
      return {}
    }
  }
  const oldCli = manifest.claude?.cliSessionId ?? null
  const cliTaken = oldCli !== null && Object.values(await readMap()).includes(oldCli)
  const cli = oldCli === null ? null : reId || cliTaken ? randomUUID() : oldCli
  const project = claudeProjectDirForCwd(cwd, paths.env, paths.home)

  const destination = (part: LanePart): string => {
    switch (part.kind) {
      case 'transcript':
        return sessionFile
      case 'runs':
        return join(sessionFile.replace(/\.jsonl$/, ''), part.path)
      case 'subagent':
        return join(sessionDir, 'subagent-artifacts', part.path)
      case 'claude-transcript':
        return join(project, `${cli}.jsonl`)
      case 'claude-sidecar':
        return join(project, cli!, part.path)
      case 'claude-prompt':
        return join(stateDir, 'sysprompt', `${cli}.txt`)
      case 'attachment':
        if (!input.attachmentsDir) refuse('The lane bundle is damaged.')
        return join(input.attachmentsDir(sessionId), part.path)
    }
  }
  const plan = manifest.parts.map((part, index) => ({ part, index, to: destination(part) }))
  const skip = new Set<number>()
  for (const { part, index, to } of plan) {
    if (!(await present(to))) continue
    // Subagent artifacts are shared by a folder's lanes; an identical file is already here.
    if (part.kind === 'subagent' && (await sha256File(to).catch(() => '')) === part.sha256)
      skip.add(index)
    else refuse(`Part of this lane already exists on ${input.labels.to}. Nothing was changed.`)
  }

  const written: string[] = []
  const dirs = new Set<string>()
  let mapped = false
  const undo = async () => {
    for (const path of [...written].reverse()) await rm(path, { force: true }).catch(() => undefined)
    for (const dir of [...dirs].sort((a, b) => b.length - a.length))
      await rmdir(dir).catch(() => undefined)
    if (mapped && cli) {
      const map = await readMap()
      if (map[sessionId] === cli) {
        delete map[sessionId]
        await writeFile(mapPath, JSON.stringify(map, null, 2), 'utf8').catch(() => undefined)
      }
    }
  }
  const ensureDir = async (dir: string, mode?: number) => {
    for (let at = dir; !(await present(at)); at = dirname(at)) dirs.add(at)
    await mkdir(dir, { recursive: true, ...(mode ? { mode } : {}) })
  }
  /** A private file (an attachment) also gets a private folder. */
  const put = async (to: string, bytes: Buffer | string, mode?: number) => {
    await ensureDir(dirname(to), mode ? 0o700 : undefined)
    await writeFile(to, bytes, { flag: 'wx', ...(mode ? { mode } : {}) })
    written.push(to)
  }
  try {
    const moved: { from: string; to: string }[] = []
    for (const { part, index, to } of plan) {
      if (part.kind === 'transcript' || skip.has(index)) continue
      const bytes = await archive.read(index)
      if (part.kind === 'runs' && part.path.endsWith('.jsonl'))
        await put(to, rewriteHeader(bytes.toString('utf8'), cwd, undefined, source.cwd))
      else if (part.kind === 'claude-transcript')
        await put(to, rewriteCli(bytes.toString('utf8'), oldCli!, cli!))
      else if (part.kind === 'attachment') {
        await put(to, bytes, 0o600)
        moved.push({ from: part.from!, to })
      } else await put(to, bytes)
    }
    if (cli) {
      const map = await readMap()
      map[sessionId] = cli
      await ensureDir(stateDir)
      await writeFile(mapPath, JSON.stringify(map, null, 2), 'utf8')
      mapped = true
    }
    const transcript = manifest.parts.findIndex((part) => part.kind === 'transcript')
    const text = rewriteHeader(
      (await archive.read(transcript)).toString('utf8'),
      cwd,
      sessionId,
    )
    const split = splitTranscript(text)
    if (!split) refuse('The lane bundle is damaged.')
    const notice = noticeText({
      labels: input.labels,
      source,
      plan: input.plan,
      cwd,
      attachments: moved,
      at: now,
    })
    const body = text.endsWith('\n') ? text : `${text}\n`
    const entry = noticeEntry(notice, transcriptFacts(split.rest).leafId, now)
    const temporary = join(sessionDir, `.${fileName}.${randomBytes(6).toString('hex')}.tmp`)
    await put(temporary, `${body}${entry}\n`)
    await utimes(temporary, now, new Date(manifest.modifiedAt))
    // `link` refuses an existing name: a transcript that appeared meanwhile is never replaced.
    await link(temporary, sessionFile)
    written.push(sessionFile)
    await unlink(temporary)
    written.splice(written.indexOf(temporary), 1)
    return { sessionFile, sessionId, undo }
  } catch (error) {
    await undo()
    throw error
  }
}
