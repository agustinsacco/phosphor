import { existsSync, readdirSync, statSync } from 'node:fs'
import { readdir, stat, open } from 'node:fs/promises'
import { isAbsolute, join, relative, sep } from 'node:path'
import { piSessionsRoot, sessionDirForCwd, sessionDirNameForCwd } from '../pi/pi-paths'
import { listSessions } from '../pi/session-scanner'
import { registry } from '../registry'
import { getPrefs } from '../store'
import { decideSession, history, sessionDecision, withWorkspace } from './history'
import { sessionPathKey } from '../pi/session-path-lock'

function conversationPrefs() {
  const prefs = getPrefs()
  const seen = new Map<string, number>()
  for (const [path, at] of Object.entries(prefs.seenSessions)) {
    const key = sessionPathKey(path)
    seen.set(key, Math.max(seen.get(key) ?? 0, at))
  }
  return { seen, pinned: new Set(prefs.pinnedSessions.map(sessionPathKey)) }
}

async function sessionCwd(path: string): Promise<string | null> {
  const handle = await open(path, 'r')
  try {
    const buffer = Buffer.alloc(16_384)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    const header = JSON.parse(buffer.toString('utf8', 0, bytesRead).split('\n')[0]!) as {
      type?: string
      cwd?: string
    }
    return header.type === 'session' && header.cwd && isAbsolute(header.cwd) ? header.cwd : null
  } finally {
    await handle.close()
  }
}

/** Read failures are fatal to eligibility, not evidence of an empty lane. */
export async function conversationFacts(path: string) {
  let files: string[]
  try {
    files = (await readdir(sessionDirForCwd(path))).filter((file) => file.endsWith('.jsonl'))
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
    if (
      completed &&
      registry.list().some((s) => sessionPathKey(s.workspacePath) === sessionPathKey(cwd))
    )
      throw new Error('Suspend all sessions in this worktree before finishing the conversation.')
    await stat(path)
    decideSession(path, completed)
  })
}

/** Header-based discovery survives checkout deletion, including pre-upgrade losses. */
export async function retainedWorkspaces(repoPath: string): Promise<string[]> {
  const found = new Set(
    history()
      .get('removals')
      .filter((r) => r.repoPath === repoPath)
      .map((r) => r.path),
  )
  const root = piSessionsRoot()
  let dirs: string[]
  try {
    dirs = await readdir(root)
  } catch {
    return [...found]
  }
  const prefix = sessionDirNameForCwd(repoPath).slice(0, -2)
  for (const dir of dirs.filter((name) => name.startsWith(prefix))) {
    let files: string[]
    try {
      files = await readdir(join(root, dir))
    } catch {
      continue
    }
    for (const file of files.filter((name) => name.endsWith('.jsonl'))) {
      try {
        const cwd = await sessionCwd(join(root, dir, file))
        if (!cwd) continue
        const rel = relative(join(repoPath, '.phosphor', 'worktrees'), cwd)
        if (rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) found.add(cwd)
      } catch {
        /* A malformed or concurrently deleted transcript does not hide other histories. */
      }
    }
  }
  return [...found].filter((path) => path !== repoPath)
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
