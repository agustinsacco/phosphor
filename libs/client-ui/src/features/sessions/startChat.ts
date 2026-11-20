import type { LaneWorktreeResult } from '@shared/models'
import type { ImageContent } from '@shared/rpc'
import { useSessionsStore } from '@/stores/sessions'
import { useNamingStore } from '@/stores/naming'
import { useChatStore } from '@/stores/chat'
import { useWorkspacesStore } from '@/stores/workspaces'
import { notifyLane } from './laneNotices'
import { repoWorktrees, useWorktreesStore } from '@/stores/worktrees'
import { branchNameFor } from '@shared/branchName'
import { lanePrefs } from '@/stores/lanePrefs'
import { sessionTitle } from '@/lib/sessionTitle'
import { workspaceName } from '@/lib/path'
import { piCallOk } from '@/lib/rpc'

/**
 * Starting a chat from the home composer: branch it, run it, name it.
 *
 * A chat that edits files wants its own branch, and pi never titles a session,
 * so Phosphor asks a one-shot `pi -p` for a name and derives the branch from it —
 * one chat, one branch, one name.
 *
 * The ORDER of those three is the whole design, and it is the opposite of what
 * it was. Naming used to run first, because the branch is named after the
 * title and a pi session is bound to the cwd it spawns in (it records its
 * transcript under a mangling of that path), so there is no moving a live
 * session into a worktree afterwards — the branch genuinely has to exist
 * before pi spawns.
 *
 * But `pi -p` is a whole agent boot: measured at ~6s before the model is even
 * asked anything, ~13s for a real naming prompt. Blocking the send button on
 * that made "new chat" read as a hang, and — because the wait was capped at
 * 12s — the title lost its own race every single time, so every auto-created
 * branch was in fact named after a slug of the first message and the generated
 * name arrived only via a SECOND ~13s call. Two model calls, ~26s, no title.
 *
 * So the dependency is inverted instead: the branch is cut immediately from a
 * slug of the first message, pi spawns and starts inference right away, and
 * the title is generated off the critical path. When it lands it sets the
 * session name and renames the branch to match (`git branch -m` is safe on a
 * branch a worktree has checked out; the folder keeps its slug, because moving
 * it would move a live session's cwd). The names still agree — a few seconds
 * later than before, having actually arrived rather than timed out.
 *
 * Every step still degrades instead of aborting: an unreachable remote falls
 * back to local trunk, a git refusal starts a plain session in the open folder
 * with the reason shown, and a failed naming leaves the slug in place. The
 * user's message is never lost to a failure in any of this.
 *
 * **None of the naming above actually ran until 2026-08-26.** The handler
 * behind `pi:generateTitle` used `execFile`, which leaves the child's stdin an
 * open pipe, and `pi -p` waits for stdin EOF — so every request sat idle until
 * its 30s timeout and returned null, silently, with empty stdout and empty
 * stderr. No session was ever auto-named and no branch was ever renamed; the
 * only visible symptom was that every branch kept its message slug. Fixed in
 * electron/pi/print-mode.ts, which spawns with stdin ignored. Read the note
 * there before touching that spawn.
 */

export type StartChatPhase = 'branching' | 'starting'

export interface StartChatOptions {
  /** Workspace the home screen is composing against. */
  workspacePath: string
  prompt: string
  images?: ImageContent[]
  /** Apply this draft's authorization before delivering its first prompt. */
  swarm?: boolean
  /**
   * Navigation this send belongs to (`claimNav`), taken when the user hit
   * Enter. Everything that would take the screen is checked against it, so a
   * lane the user has already navigated away from finishes in the background.
   */
  nav?: number
  /** Progress for the composer's button label. */
  onPhase?: (phase: StartChatPhase) => void
  /** Non-fatal problem to surface; the session still starts. */
  onWarning?: (message: string) => void
}

export interface StartChatResult {
  sessionId: string
  /** Where the session actually started (a worktree, or the original folder). */
  workspacePath: string
  /** Branch created for this chat, when one was. */
  branch?: string
}

/**
 * Create the chat the composer just described.
 *
 * Returns once the session exists and its first prompt is on the way; the
 * transcript streams in on its own after that, and so does the name.
 */
export async function startChat(options: StartChatOptions): Promise<StartChatResult> {
  const { workspacePath, prompt, images, nav, swarm } = options
  const initial = { firstPrompt: prompt, firstImages: images, nav, swarm }
  /** Is the user still waiting on this send, or have they moved on? */
  const claimed = (): boolean => nav === undefined || useSessionsStore.getState().navSeq === nav
  const startInPlace = async (): Promise<StartChatResult> => {
    options.onPhase?.('starting')
    const sessionId = await useSessionsStore.getState().createSession(workspacePath, initial)
    return { sessionId, workspacePath }
  }
  if (!useWorktreesStore.getState().preferWorktree) return startInPlace()

  options.onPhase?.('branching')
  const created = await createLaneWorktree(workspacePath, prompt)
  if (created.kind === 'unisolated') return startInPlace()
  if (created.kind === 'failed') {
    // Git refused (a locked index, a name race, a repo in an odd state). The
    // message is worth more than the branch: start where we are and say why.
    options.onWarning?.(
      `Couldn't create the branch ${created.branch} — this session is running in ${workspaceName(created.repoPath)} instead. ${created.error}`,
    )
    return startInPlace()
  }

  const { repoPath } = created
  const cwd = created.worktree.realPath
  options.onPhase?.('starting')
  // Point the window at the new worktree before the session starts, so the top
  // bar and file tree describe the place the session is actually running in.
  //
  // Safe to do ahead of the session only because `stores/startingChat.ts` is
  // covering this window. Without it, `activeSessionId` is still null here and
  // the app fell back to the greeting screen — which then re-rendered for the
  // brand-new, empty worktree ("Start your first session in hey-2") for a beat
  // before the chat replaced it.
  //
  // Skipped once the user has navigated away: cutting the branch takes seconds,
  // and re-pointing the window at this worktree after they opened another lane
  // would move the file tree and top bar out from under them.
  if (claimed()) useWorkspacesStore.getState().openWorkspace(cwd)

  const sessionId = await useSessionsStore
    .getState()
    .createSession(cwd, {
      ...initial,
      // The store's own auto-naming pass is suppressed because this flow owns
      // naming end to end: the title has to reach the branch as well as the
      // session, and two independent naming calls would mean two names.
      autoName: false,
    })
    .catch((error: unknown) => {
      // Startup can reject Swarm before sending. Return to the composer that
      // owns the restored draft, but never steal a newer navigation.
      if (claimed()) useWorkspacesStore.getState().openWorkspace(workspacePath)
      throw error
    })
  // The branch picker and sidebar learn of the new worktree here, after pi is
  // up: the full listing reads every checkout's dirty state, which is seconds
  // of git in a repository with many lanes, and nothing above needed it.
  void useWorktreesStore.getState().refresh(repoPath)

  const branch = created.worktree.branch ?? undefined
  // Deliberately not awaited: this is the ~13s call that used to be in front
  // of the send button. Skipped entirely when the user turned auto-naming off,
  // in which case the session keeps its first-message title and the branch
  // keeps the slug it was created with.
  if (lanePrefs().autoName) {
    void nameChat({ sessionId, repoPath, cwd, prompt, branch })
  }

  return { sessionId, workspacePath: cwd, branch }
}

/**
 * Cut this chat's branch and worktree, named from its first message.
 *
 * Main does it in one call (`git:createLaneWorktree`): it finds the repo of
 * record, reads the taken names and runs `git worktree add`. A chat started
 * inside a worktree still branches off trunk in its main tree, because "new
 * chat" means new work; the sidebar's "New session here" continues a branch.
 */
async function createLaneWorktree(
  workspacePath: string,
  title: string,
): Promise<LaneWorktreeResult> {
  try {
    return await window.phosphor.invoke('git:createLaneWorktree', workspacePath, {
      title,
      prefix: useWorktreesStore.getState().branchPrefix,
      maxSlug: lanePrefs().branchSlugMaxLength,
    })
  } catch {
    // Main itself failed: a plain session is the right answer, as for no repo.
    return { kind: 'unisolated' }
  }
}

/**
 * Give the running chat its real name, and its branch the same one.
 *
 * Runs after the session is live and streaming, so nothing here is on a user's
 * critical path and every failure is simply "the slug stands". The session
 * name is set first: it is the visible one, and a branch rename that failed
 * must not cost the user their title too.
 */
async function nameChat({
  sessionId,
  repoPath,
  cwd,
  prompt,
  branch,
}: {
  sessionId: string
  repoPath: string
  cwd: string
  prompt: string
  branch?: string
}): Promise<void> {
  // Flagged for the whole operation, branch rename included: the branch chip
  // is one of the surfaces about to change, so it stays marked provisional
  // until there is nothing left to change.
  useNamingStore.getState().start(sessionId, cwd)
  try {
    await applyGeneratedName({ sessionId, repoPath, cwd, prompt, branch })
  } finally {
    useNamingStore.getState().finish(sessionId)
  }
}

/** The naming itself, split out so `nameChat` owns only the pending flag. */
async function applyGeneratedName({
  sessionId,
  repoPath,
  cwd,
  prompt,
  branch,
}: {
  sessionId: string
  repoPath: string
  cwd: string
  prompt: string
  branch?: string
}): Promise<void> {
  const title = await generateTitle(repoPath, cwd, prompt)
  if (!title) return
  // The user may have renamed or closed the chat during those seconds — the
  // same two guards the store's auto-naming pass uses.
  if (useChatStore.getState().sessions[sessionId]?.meta?.sessionName) return
  if (!useSessionsStore.getState().live[sessionId]) return

  // Naming lands ~13s after the send, by which time the user may be working in
  // another lane — where nothing on screen would otherwise show that their new
  // lane finished setting itself up.
  const watching = useSessionsStore.getState().activeSessionId === sessionId

  if (await piCallOk(sessionId, { type: 'set_session_name', name: title })) {
    // `patchMeta` is what the user actually sees. pi appends the rename to
    // the session file at once, but the folder watcher reports it only after
    // its debounce, so every surface that shows a live session's title
    // prefers the chat store's name over the scanned one (see `SessionRow` in
    // LocalLaneRow.tsx).
    useChatStore.getState().patchMeta(sessionId, { sessionName: title })
    // The scan that picks the name up without waiting for the watcher.
    void useSessionsStore.getState().refreshDisk(cwd)
    if (!watching) notifyLane(sessionId, { title, message: 'Named your new lane.' })
  }

  if (!branch) return
  const store = useWorktreesStore.getState()
  await store.refresh(repoPath)
  const repo = repoWorktrees(useWorktreesStore.getState(), repoPath)
  const { branch: renamed } = branchNameFor({
    title,
    prefix: useWorktreesStore.getState().branchPrefix,
    // The chat's current branch is itself in this list; excluding it keeps a
    // title that already slugs to the branch we have from being suffixed "2".
    takenBranches: repo.branches.map((b) => b.name).filter((name) => name !== branch),
    takenFolders: [],
    maxSlug: lanePrefs().branchSlugMaxLength,
  })
  if (renamed === branch) return
  await store.renameBranch(repoPath, branch, renamed)
  // The sidebar's branch chips read `gitByCwd`, which nothing else invalidates
  // on a rename.
  void useSessionsStore.getState().refreshGitInfo([cwd])
}

/**
 * Ask for a session name.
 *
 * Unbounded on purpose now that it is off the critical path — `pi:generateTitle`
 * already fails soft (null rather than throwing) and the subprocess behind it
 * carries its own 30s timeout in main. The renderer-side race this used to run
 * was a 12s cap on a ~13s call, which is to say a guarantee of no title at all.
 */
async function generateTitle(
  repoPath: string,
  workspacePath: string,
  prompt: string,
): Promise<string | null> {
  const existing = existingTitlesForRepo(repoPath, workspacePath)
  return window.phosphor
    .invoke('pi:generateTitle', workspacePath, prompt, existing)
    .catch(() => null)
}

/**
 * Session titles already used anywhere in this repo, worktrees included.
 *
 * Scoped to the repo rather than the folder because that is the scope the
 * names have to be unique in: every worktree's branch lives in one repo, and
 * the sidebar folds all of their sessions into one group.
 */
function existingTitlesForRepo(repoPath: string, workspacePath: string): string[] {
  const { disk } = useSessionsStore.getState()
  const titles: string[] = []
  for (const [path, metas] of Object.entries(disk)) {
    // Both separators: worktree paths reach the renderer as the OS wrote them.
    const inRepo =
      path === repoPath ||
      path === workspacePath ||
      path.startsWith(`${repoPath}/`) ||
      path.startsWith(`${repoPath}\\`)
    if (!inRepo) continue
    for (const meta of metas) {
      const title = sessionTitle({ explicitName: meta.name, firstUserText: meta.firstUserText })
      if (title) titles.push(title)
    }
  }
  return titles
}

/**
 * Warm the refs a new chat will branch from, ahead of the send.
 *
 * Call from a screen where a chat is about to be composed. A send never
 * fetches: `git:createLaneWorktree` branches from the refs already on disk,
 * because the round trip (~0.8s warm, up to 3s cold) made a new chat feel
 * slow. This moves that fetch to while the user is typing instead, and is
 * cheap to call repeatedly (main throttles to once per 3 minutes per repo) and
 * safe to ignore: nothing waits on it and a failure only means the next branch
 * starts from the trunk we already had.
 */
export function prefetchTrunk(workspacePath: string): void {
  void (async () => {
    try {
      const info = await window.phosphor.invoke('git:info', workspacePath)
      if (!info.isRepo) return
      const repoPath = info.isWorktree && info.mainRepoPath ? info.mainRepoPath : workspacePath
      await useWorktreesStore.getState().syncRemote(repoPath)
    } catch {
      // Offline, no remote, not a repo: the send falls back to local trunk.
    }
  })()
}

/** The same prompt slug and preferences for This Mac and Host worktrees. */
export function newChatBranchName(
  title: string,
  taken: { takenBranches: string[]; takenFolders: string[] },
) {
  return branchNameFor({
    title,
    prefix: useWorktreesStore.getState().branchPrefix,
    maxSlug: lanePrefs().branchSlugMaxLength,
    ...taken,
  })
}
