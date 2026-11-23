import {
  discoverRetainedWorkspaces,
  sessionCwd,
} from '@phosphor/session-runtime/lanes/visible-lanes'
import { existsSync, readdirSync, statSync } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { piSessionsRoot, sessionDirForCwd } from '../pi/pi-paths'
import { listSessions } from '../pi/session-scanner'
import { workspaceHasLiveLane } from './reservation'
import { getPrefs } from '../store'
import { decideSession, history, sessionDecision, withWorkspace } from './history'
import { sessionPathKey } from '@phosphor/session-runtime/pi/session-path-lock'

function conversationPrefs() {
  const prefs = getPrefs()
  const seen = new Map<string, number>()
  for (const [path, at] of Object.entries(prefs.seenSessions)) {
    const key = sessionPathKey(path)
    seen.set(key, Math.max(seen.get(key) ?? 0, at))
  }
  return { seen, pinned: new Set(prefs.pinnedSessions.map(sessionPathKey)) }
}

/** Read failures are fatal to eligibility, not evidence of an empty lane. */
export async function conversationFacts(path: string) {
  let files: string[]
  try {
    files = (await readdir(sessionDirForCwd(path))).filter(
      (file) => file.endsWith('.jsonl') || file.endsWith('.jsonl.archived'),
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    files = []
  }
  const prefs = conversationPrefs()
  const sessions = await listSessions(path)
  const activity = await Promise.all(
    files.map(async (file) => {
      const transcript = join(sessionDirForCwd(path), file)
      const decision = sessionDecision(transcript)
      return Math.max(
        (await stat(transcript)).mtimeMs,
        decision.activityAt,
        prefs.seen.get(sessionPathKey(transcript)) ?? 0,
      )
    }),
  )
  const decisions = sessions.map((session) => ({
    id: session.sessionId,
    path: session.path,
    completedAt: sessionDecision(session.path).completedAt ?? 0,
    activityAt: Math.max(
      session.mtimeMs,
      sessionDecision(session.path).activityAt,
      prefs.seen.get(sessionPathKey(session.path)) ?? 0,
    ),
  }))
  // Empty, malformed and legacy lanes require a decision, never vacuous approval.
  const complete =
    files.length > 0 &&
    decisions.length === files.length &&
    decisions.every((s) => s.completedAt > 0)
  return {
    sessions: decisions,
    completedAtMs: complete ? Math.max(...decisions.map((s) => s.completedAt)) : null,
    lastWriteMs: Math.max(0, ...activity),
    pinned: sessions.some((s) => prefs.pinned.has(sessionPathKey(s.path))),
  }
}

export async function setCompleted(path: string, completed: boolean): Promise<void> {
  const cwd = await sessionCwd(path)
  if (!cwd) throw new Error('Invalid session cwd.')
  await withWorkspace(cwd, async () => {
    if (completed && workspaceHasLiveLane(cwd))
      throw new Error('Suspend all sessions in this worktree before finishing the conversation.')
    await stat(path)
    decideSession(path, completed)
  })
}

export function retainedWorkspaces(repoPath: string) {
  return discoverRetainedWorkspaces(
    repoPath,
    piSessionsRoot(),
    history()
      .get('removals')
      .filter((r) => r.repoPath === repoPath)
      .map((r) => r.path),
  )
}

/** Small synchronous final guard after Git's last async scan, immediately before remove. */
export function conversationSnapshot(path: string, knownPaths: string[]) {
  const dir = sessionDirForCwd(path)
  const files = readdirSync(dir)
    .filter((file) => file.endsWith('.jsonl'))
    .map((file) => join(dir, file))
  if (
    !files.length ||
    files.length !== knownPaths.length ||
    files.some((file) => !knownPaths.includes(file))
  )
    throw new Error('Conversation inventory changed; kept for safety.')
  const prefs = conversationPrefs()
  const decisions = files.map((file) => ({
    completedAt: sessionDecision(file).completedAt ?? 0,
    activityAt: Math.max(
      statSync(file).mtimeMs,
      sessionDecision(file).activityAt,
      prefs.seen.get(sessionPathKey(file)) ?? 0,
    ),
  }))
  return {
    completedAtMs: decisions.every((s) => s.completedAt > 0)
      ? Math.max(...decisions.map((s) => s.completedAt))
      : null,
    lastWriteMs: Math.max(
      statSync(path).mtimeMs,
      statSync(dir).mtimeMs,
      ...decisions.map((s) => s.activityAt),
    ),
    pinned: files.some((file) => prefs.pinned.has(sessionPathKey(file))),
  }
}

export const checkoutMissing = (cwd: string): boolean => !existsSync(cwd)
