import { readFile, stat } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import {
  LANE_TRANSFER_LIMITS as LIMIT,
  isSessionId,
  isTranscriptName,
  type LaneGitFacts,
  type LaneManifest,
  type LanePart,
  type LanePartKind,
} from '@phosphor/shared/host-protocol-lane-transfer'
import { claudeProjectDirForCwd, claudeProviderStateDir } from '../pi/pi-paths'
import { refuse, regularSize, sha256File, walkFiles } from './files'
import { parseHeader, splitTranscript, transcriptFacts } from './transcript'

/** Where one machine keeps what a lane is made of. */
export interface MachinePaths {
  env: NodeJS.ProcessEnv
  home: string
}

export interface CollectInput {
  sessionFile: string
  /** The source workspace's folder name, for the move notice. */
  workspace: string
  git: LaneGitFacts | null
  paths: MachinePaths
  /** Whether an attachment the transcript names may leave this machine. */
  attachmentAllowed(path: string): boolean
}

export interface CollectedLane {
  manifest: LaneManifest
  /** The absolute file each part is read from, by part index. */
  files: string[]
}

/** The child-run folder pi-subagents keeps beside a transcript, named after it. */
export const runsDirFor = (sessionFile: string) => sessionFile.replace(/\.jsonl$/, '')

async function cliSessionFor(paths: MachinePaths, sessionId: string): Promise<string | null> {
  try {
    const map = JSON.parse(
      await readFile(join(claudeProviderStateDir(paths.env, paths.home), 'session-map.json'), 'utf8'),
    ) as unknown
    const id = map && typeof map === 'object' ? (map as Record<string, unknown>)[sessionId] : null
    return isSessionId(id) ? id : null
  } catch {
    return null
  }
}

/**
 * Read a stopped lane into a manifest without changing anything. Attachments
 * that are gone, changed type or grew past the limit are left out: they are
 * history, not something the lane needs to continue.
 */
export async function collectLane(input: CollectInput): Promise<CollectedLane> {
  const { sessionFile, paths } = input
  const fileName = basename(sessionFile)
  const transcriptBytes = await regularSize(sessionFile)
  if (!isTranscriptName(fileName) || transcriptBytes === null)
    refuse('This lane has no saved transcript to move.')
  if (transcriptBytes > LIMIT.bundleBytes) refuse('This lane is too large to move.')
  const text = await readFile(sessionFile, 'utf8')
  const split = splitTranscript(text)
  const header = split && parseHeader(split.header)
  if (!split || !header || !fileName.endsWith(`_${header.id}.jsonl`))
    refuse('This transcript is in a format Phosphor cannot move.')
  const facts = transcriptFacts(split.rest)
  const parts: LanePart[] = []
  const files: string[] = []
  const add = async (kind: LanePartKind, path: string, file: string, from?: string) => {
    const size = await regularSize(file)
    if (size === null) return
    if (parts.length >= LIMIT.parts) refuse('This lane has too many files to move.')
    parts.push({ kind, path, size, sha256: await sha256File(file), ...(from ? { from } : {}) })
    files.push(file)
  }
  await add('transcript', '', sessionFile)
  if (parts[0]?.size !== transcriptBytes) refuse('This lane changed while it was being read.')

  const runs = runsDirFor(sessionFile)
  const runFiles = await walkFiles(runs, LIMIT.parts)
  for (const path of runFiles) await add('runs', path, join(runs, path))
  const runIds = new Set(runFiles.map((path) => path.split('/')[0]!))
  const artifacts = join(dirname(sessionFile), 'subagent-artifacts')
  for (const path of await walkFiles(artifacts, LIMIT.parts * 4)) {
    // The folder is shared by every lane in this cwd: take only this lane's runs.
    const runId = path.split('/')[0]!.split('_')[0]!
    if (runIds.has(runId) || text.includes(`subagent-artifacts/${path}`))
      await add('subagent', path, join(artifacts, path))
  }

  const cli = await cliSessionFor(paths, header.id)
  let claude: LaneManifest['claude'] = null
  if (cli) {
    const project = claudeProjectDirForCwd(header.cwd, paths.env, paths.home)
    const transcript = join(project, `${cli}.jsonl`)
    if ((await regularSize(transcript)) !== null) {
      claude = { cliSessionId: cli }
      await add('claude-transcript', '', transcript)
      const sidecar = join(project, cli)
      for (const path of await walkFiles(sidecar, LIMIT.parts))
        await add('claude-sidecar', path, join(sidecar, path))
      await add(
        'claude-prompt',
        '',
        join(claudeProviderStateDir(paths.env, paths.home), 'sysprompt', `${cli}.txt`),
      )
    }
  }

  let index = 0
  for (const from of facts.attachments) {
    if (!input.attachmentAllowed(from)) continue
    const size = await regularSize(from)
    if (size === null || size > LIMIT.attachmentBytes) continue
    const name = basename(from).replace(/[^A-Za-z0-9._-]/g, '_').slice(-120) || 'file'
    await add('attachment', `${index++}/${name}`, from, from)
  }

  const bytes = parts.reduce((sum, part) => sum + part.size, 0)
  if (bytes > LIMIT.bundleBytes) refuse('This lane is too large to move (over 256 MiB).')
  const modifiedAt = Math.floor((await stat(sessionFile)).mtimeMs)
  return {
    files,
    manifest: {
      version: 1,
      fileName,
      modifiedAt,
      claude,
      parts,
      source: {
        sessionId: header.id,
        title: facts.title,
        workspace: input.workspace.slice(0, 255) || 'folder',
        cwd: header.cwd,
        git: input.git,
        bytes,
        transcriptBytes,
      },
    },
  }
}
