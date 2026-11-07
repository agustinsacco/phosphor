import { open, opendir, readdir } from 'node:fs/promises'
import { join } from 'node:path'
import {
  LANE_TRANSFER_LIMITS as LIMIT,
  type LaneSourceFacts,
  type LaneTargetPlan,
} from '@phosphor/shared/host-protocol-lane-transfer'
import type { LaneInspection } from '@phosphor/shared/host-protocol-lane-transfer-calls'
import { piSessionsRoot } from '../pi/pi-paths'
import { openArchive, writeArchive, type ArchiveReader } from './archive'
import { collectLane, type CollectedLane, type MachinePaths } from './collect'
import { TransferRefusal, refuse } from './files'
import { inspectSourceGit } from './source-git'
import {
  inspectTargetGit,
  planMove,
  prepareTarget,
  type PreparedFolder,
  type WorktreePort,
} from './target'
import { parseHeader } from './transcript'
import { runtimeBlockers, type RuntimeProbe } from './runtime'

export interface SourceInput {
  runtime?: RuntimeProbe
  sessionFile: string
  /** The source workspace's folder name. */
  workspace: string
  paths: MachinePaths
  attachmentAllowed(path: string): boolean
}

/** The cwd a transcript's header records. */
export async function headerCwd(sessionFile: string): Promise<string> {
  const handle = await open(sessionFile, 'r').catch(() =>
    refuse('This lane has no saved transcript to move.'),
  )
  try {
    const buffer = Buffer.alloc(8192)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const text = buffer.subarray(0, bytesRead).toString('utf8')
    const header = parseHeader(text.slice(0, Math.max(0, text.indexOf('\n'))))
    if (!header) refuse('This transcript is in a format Phosphor cannot move.')
    return header.cwd
  } finally {
    await handle.close()
  }
}

/** Read a stopped lane: its facts, or every reason it cannot leave. Changes nothing. */
async function readSource(input: SourceInput): Promise<CollectedLane | { blockers: string[] }> {
  const cwd = await headerCwd(input.sessionFile)
  const git = await inspectSourceGit(cwd)
  if (git.kind === 'unreadable') return { blockers: ['Git could not read this lane’s folder.'] }
  if (git.kind === 'git' && git.blockers.length) return { blockers: git.blockers }
  return collectLane({
    ...input,
    runtime: await input.runtime?.(false, cwd),
    git: git.kind === 'git' ? git.facts : null,
  })
}

export async function inspectLane(input: SourceInput): Promise<LaneInspection> {
  try {
    const read = await readSource(input)
    return 'blockers' in read ? read : { facts: read.manifest.source }
  } catch (error) {
    if (error instanceof TransferRefusal) return { blockers: [error.message] }
    throw error
  }
}

/** Write the lane's bundle to `archivePath`. Refuses whatever `inspectLane` would report. */
export async function exportLane(
  input: SourceInput,
  archivePath: string,
): Promise<{ size: number; sha256: string }> {
  const read = await readSource(input)
  if ('blockers' in read) refuse(read.blockers[0]!)
  return writeArchive(read, archivePath)
}

export interface TargetInput {
  runtime?: RuntimeProbe
  /** The target workspace's resolved path. */
  root: string
  workspace: string
  branchPrefix: string
  sameMachine: boolean
  /** A Host indexes artifacts from a bounded transcript; This Mac sets none. */
  maxTranscriptBytes?: number
  /** Refuse rather than shorten a name this target cannot store. */
  maxTitleLength?: number
}

export async function checkTarget(
  input: TargetInput,
  source: LaneSourceFacts,
): Promise<LaneTargetPlan> {
  const plan = planMove({ ...input, source, target: await inspectTargetGit(input.root) })
  if (input.maxTranscriptBytes !== undefined && source.transcriptBytes > input.maxTranscriptBytes)
    plan.blockers.push('This lane’s transcript is over 32 MiB, more than a Host can index.')
  if (input.maxTitleLength !== undefined && (source.title?.length ?? 0) > input.maxTitleLength)
    plan.blockers.push(
      `This Host cannot preserve a lane name longer than ${input.maxTitleLength} characters.`,
    )
  if (input.runtime)
    plan.blockers.push(...runtimeBlockers(source, await input.runtime(true, input.root)))
  plan.blockers.splice(LIMIT.messages)
  return plan
}

export interface PreparedImport {
  archive: ArchiveReader
  plan: LaneTargetPlan
  folder: PreparedFolder
}

/**
 * Verify a received bundle, check the target again and make its folder. The
 * caller installs the lane next, then undoes `folder` if anything fails.
 */
export async function prepareImport(
  input: TargetInput & { archivePath: string; worktrees: WorktreePort },
): Promise<PreparedImport> {
  const archive = await openArchive(input.archivePath)
  const plan = await checkTarget(input, archive.manifest.source)
  const folder = await prepareTarget({
    plan,
    root: input.root,
    source: archive.manifest.source,
    worktrees: input.worktrees,
  })
  return { archive, plan, folder }
}

/** Whether any pi session on this machine already uses `sessionId`. */
export function sessionTaken(paths: MachinePaths) {
  return async (sessionId: string): Promise<boolean> => {
    const root = piSessionsRoot(paths.env, paths.home)
    let dirs
    try {
      dirs = await opendir(root)
    } catch {
      return false
    }
    for await (const dir of dirs) {
      if (!dir.isDirectory()) continue
      const names = await readdir(join(root, dir.name)).catch(() => [] as string[])
      if (names.some((name) => name.endsWith(`_${sessionId}.jsonl`))) return true
    }
    return false
  }
}
