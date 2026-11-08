import { realpath, stat } from 'node:fs/promises'
import { homedir } from 'node:os'
import { basename, dirname, isAbsolute, sep } from 'node:path'
import type {
  LaneMoveNotice,
  LaneSourceFacts,
  LaneTargetPlan,
} from '@shared/host-protocol-lane-transfer'
import type { LaneInspection } from '@shared/host-protocol-lane-transfer-calls'
import { git } from '@phosphor/session-runtime/git/git-exec'
import { TransferRefusal, refuse } from '@phosphor/session-runtime/lane-transfer/files'
import { installLane } from '@phosphor/session-runtime/lane-transfer/install'
import {
  checkTarget,
  exportLane,
  readTransferHeader,
  inspectLane,
  prepareImport,
  sessionTaken,
  type SourceInput,
} from '@phosphor/session-runtime/lane-transfer/move'
import type { WorktreePort } from '@phosphor/session-runtime/lane-transfer/target'
import { addWorktree, removeWorktree, startPoint } from '../fs/git-worktrees'
import { piSessionsRoot } from '../pi/pi-paths'
import { sessionPathKey } from '@phosphor/session-runtime/pi/session-path-lock'
import { withSessionPath } from '../pi/session-path-lock'
import { registry } from '../registry'
import { brainSourceExcluded } from '../brain/runtime'
import { laneAttachmentsDir } from './attachments-dir'
import { localTransferRuntime } from './runtime'

const paths = () => ({ env: process.env, home: homedir() })
const STOP_FIRST = 'Stop this lane before moving it. Its saved transcript is what moves.'

/** Worktrees made the way This Mac makes them, named after their branch. */
const worktrees: WorktreePort = {
  async add(root, branch, fresh) {
    const name = branch.replaceAll('/', '-')
    const start = fresh ? await startPoint(root) : null
    const info = await addWorktree(
      root,
      name,
      start
        ? { kind: 'new', branch, base: start.base, noTrack: start.fromRemote }
        : { kind: 'existing', branch },
    )
    // A branch this made is deleted on undo only while it still points where it was cut.
    const made = start ? await git(root, ['rev-parse', `refs/heads/${branch}`], { trim: true }) : ''
    return {
      cwd: info.realPath,
      undo: async () => {
        await removeWorktree(root, info.path).catch(() => undefined)
        if (made)
          await git(root, ['update-ref', '-d', `refs/heads/${branch}`, made]).catch(() => undefined)
      },
    }
  },
}

/** A transcript under pi's sessions root, by its resolved path. Anything else is refused. */
async function transcriptPath(sessionPath: string): Promise<string> {
  const real = await realpath(sessionPath).catch(() =>
    refuse('This lane has no saved transcript to move.'),
  )
  const root = await realpath(piSessionsRoot()).catch(() => '')
  if (!root || dirname(dirname(real)) !== root || !real.endsWith('.jsonl'))
    refuse('This lane has no saved transcript to move.')
  return real
}

function live(path: string): boolean {
  const key = sessionPathKey(path)
  return registry.list().some((s) => !!s.diskPath && sessionPathKey(s.diskPath) === key)
}

/** A worktree's workspace is its main checkout, named the way the sidebar names it. */
async function workspaceName(cwd: string): Promise<string> {
  const common = await git(cwd, ['rev-parse', '--path-format=absolute', '--git-common-dir'], {
    allowFail: true,
    trim: true,
  })
  return basename(common.endsWith(`${sep}.git`) ? dirname(common) : cwd)
}

async function source(sessionPath: string, crossMachine: boolean): Promise<SourceInput> {
  const sessionFile = await transcriptPath(sessionPath)
  const { cwd, id } = await readTransferHeader(sessionFile)
  const excluded = await brainSourceExcluded(id).catch(() =>
    refuse('Brain exclusion could not be checked. Try again before moving this lane.'),
  )
  if (excluded) refuse('This lane is a Brain recipient or private processor and cannot be moved.')
  return {
    sessionFile,
    runtime: localTransferRuntime,
    workspace: await workspaceName(cwd),
    paths: paths(),
    // On This Mac the attached files are still where the transcript says.
    attachmentAllowed: () => crossMachine,
  }
}

async function workspaceRoot(workspace: string): Promise<string> {
  if (!isAbsolute(workspace)) refuse('Pick a folder on This Mac.')
  const real = await realpath(workspace).catch(() => refuse('That folder no longer exists.'))
  if (!(await stat(real)).isDirectory()) refuse('That folder no longer exists.')
  return real
}

/** This Mac as the place a lane leaves from or lands in. */
export const localLanes = {
  async inspect(sessionPath: string, crossMachine: boolean): Promise<LaneInspection> {
    try {
      const input = await source(sessionPath, crossMachine)
      if (live(input.sessionFile)) return { blockers: [STOP_FIRST] }
      return inspectLane(input)
    } catch (error) {
      if (error instanceof TransferRefusal) return { blockers: [error.message] }
      throw error
    }
  },
  /** Write the lane's bundle to `archive`, holding its path so no open starts meanwhile. */
  async export(sessionPath: string, crossMachine: boolean, archive: string) {
    const sessionFile = await transcriptPath(sessionPath)
    return withSessionPath(sessionFile, async () => {
      // Re-read native identity and exclusion after queued opens/mutations, not UI preflight.
      const input = await source(sessionFile, crossMachine)
      if (input.sessionFile !== sessionFile) refuse('This lane changed before it could be moved.')
      if (live(input.sessionFile)) refuse(STOP_FIRST)
      return exportLane(input, archive)
    })
  },
  async check(
    workspace: string,
    facts: LaneSourceFacts,
    branchPrefix: string,
    sameMachine: boolean,
  ): Promise<LaneTargetPlan> {
    const root = await workspaceRoot(workspace)
    return checkTarget(
      { root, workspace: basename(root), branchPrefix, sameMachine, runtime: localTransferRuntime },
      facts,
    )
  },
  async import(input: {
    archive: string
    workspace: string
    branchPrefix: string
    sameMachine: boolean
    labels: LaneMoveNotice
  }): Promise<{ sessionPath: string; workspace: string }> {
    const root = await workspaceRoot(input.workspace)
    const prepared = await prepareImport({
      root,
      workspace: basename(root),
      branchPrefix: input.branchPrefix,
      sameMachine: input.sameMachine,
      archivePath: input.archive,
      runtime: localTransferRuntime,
      worktrees,
    })
    try {
      const installed = await installLane({
        archive: prepared.archive,
        plan: prepared.plan,
        cwd: prepared.folder.cwd,
        paths: paths(),
        labels: input.labels,
        attachmentsDir: input.sameMachine ? null : laneAttachmentsDir,
        sessionTaken: sessionTaken(paths()),
      })
      return { sessionPath: installed.sessionFile, workspace: root }
    } catch (error) {
      await prepared.folder.undo()
      throw error
    }
  },
}
