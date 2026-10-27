import { constants, existsSync } from 'node:fs'
import { open, readdir } from 'node:fs/promises'
import { basename, dirname, isAbsolute, join, relative, resolve, sep } from 'node:path'
import { git } from '@phosphor/session-runtime/git/git-exec'
import { parseSessionEntries } from '@phosphor/session-runtime/pi/session-context'
import { normalizePrefix } from '@shared/branchName'
import { errorText } from '@shared/errors'
import type { WorktreeInfo, WorktreeRecovery, WorktreeRecreateSource } from '@shared/models'
import {
  addWorktree,
  listWorktrees,
  normalizeRealPath,
  startPoint,
  worktreeRootFor,
} from '../fs/git-worktrees'
import { sessionDirForCwd } from '../pi/pi-paths'
import { sessionPathKey } from '../pi/session-path-lock'
import { notifyWorkspaceSessions } from '../pi/session-watcher'
import { registry } from '../registry'
import { getPrefs } from '../store'
import { history, withWorkspace } from './history'

/**
 * Bringing back a conversation whose checkout is gone, when there is no saved
 * commit to restore (`restoreWorktree`) or the user wants something else.
 *
 * Every option recreates the ORIGINAL path. pi keys a transcript by its cwd and
 * the Claude provider keys its own ledger the same way, so a new folder would
 * mean copying and rewriting both. The original path keeps the transcript
 * byte-for-byte untouched. What goes into that path is always the user's
 * explicit choice: a branch that matches the checkout, or a new branch from
 * trunk. Nothing is guessed silently.
 */

const EDITED_FILES_SHOWN = 20
const TRANSCRIPT_LIMIT = 64 * 1024 * 1024

/** `<repo>/.phosphor/worktrees/<name>`, the only layout `addWorktree` recreates. */
export function checkoutLayout(path: string): { repoPath: string; name: string } | null {
  if (!isAbsolute(path) || resolve(path) !== path) return null
  const root = dirname(path)
  const repoPath = dirname(dirname(root))
  if (worktreeRootFor(repoPath) !== root) return null
  return { repoPath, name: basename(path) }
}

/**
 * Files a transcript's `edit`/`write` calls changed inside `cwd`, relative to
 * it. Shell commands can change files too and are not counted, so an empty
 * list is a hint, not proof.
 */
export function editedCheckoutFiles(text: string, cwd: string): string[] {
  const entries = parseSessionEntries(text)
  if (!entries || entries[0]?.cwd !== cwd) return []
  const files = new Set<string>()
  for (const entry of entries) {
    const message = entry.message as { role?: unknown; content?: unknown } | undefined
    if (entry.type !== 'message' || message?.role !== 'assistant') continue
    if (!Array.isArray(message.content)) continue
    for (const block of message.content as unknown[]) {
      const call = block as { type?: unknown; name?: unknown; arguments?: unknown } | null
      if (call?.type !== 'toolCall' || (call.name !== 'edit' && call.name !== 'write')) continue
      const args = call.arguments as { path?: unknown; file_path?: unknown } | undefined
      const target = [args?.path, args?.file_path].find((v) => typeof v === 'string')
      if (typeof target !== 'string' || !target) continue
      const rel = relative(cwd, resolve(cwd, target))
      if (rel && rel !== '..' && !rel.startsWith(`..${sep}`) && !isAbsolute(rel)) files.add(rel)
    }
  }
  return [...files].sort()
}

async function readBounded(path: string): Promise<string | null> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = await file.stat()
    if (!info.isFile() || info.size > TRANSCRIPT_LIMIT) return null
    return (await file.readFile()).toString('utf8')
  } finally {
    await file.close()
  }
}

async function editedFiles(path: string): Promise<string[]> {
  const dir = sessionDirForCwd(path)
  let names: string[]
  try {
    names = (await readdir(dir)).filter((name) => name.endsWith('.jsonl'))
  } catch {
    return []
  }
  const files = new Set<string>()
  for (const name of names) {
    try {
      const text = await readBounded(join(dir, name))
      for (const file of text ? editedCheckoutFiles(text, path) : []) files.add(file)
    } catch {
      /* A concurrently deleted or unreadable transcript does not hide the others. */
    }
  }
  return [...files].sort()
}

const savedRecord = (path: string) =>
  history()
    .get('removals')
    .slice()
    .reverse()
    .find((entry) => entry.path === path)

interface Ref {
  tip: string
  subject: string
}

async function branchRefs(repoPath: string) {
  const local = new Map<string, Ref>()
  const remote = new Map<string, Ref>()
  const out = await git(repoPath, [
    'for-each-ref',
    'refs/heads',
    'refs/remotes/origin',
    '--format=%(refname)\t%(objectname)\t%(subject)',
  ])
  for (const line of out.split('\n').filter(Boolean)) {
    const [ref = '', tip = '', subject = ''] = line.split('\t')
    if (ref.startsWith('refs/heads/')) local.set(ref.slice(11), { tip, subject })
    else if (ref.startsWith('refs/remotes/origin/') && ref !== 'refs/remotes/origin/HEAD')
      remote.set(ref.slice(20), { tip, subject })
  }
  return { local, remote }
}

/** One branch for this checkout, or none when it would be a guess between several. */
export function pickBranch(input: {
  name: string
  prefix: string
  hints: string[]
  available: string[]
}): string | undefined {
  const { name, prefix, available } = input
  const hints = input.hints.filter((hint) => available.includes(hint))
  if (hints.length) return hints.length === 1 ? hints[0] : undefined
  const matches = available.filter((b) => b === name || b.endsWith(`/${name}`))
  if (matches.length === 1) return matches[0]
  return matches.includes(`${prefix}${name}`) ? `${prefix}${name}` : undefined
}

interface Plan {
  repoPath: string
  name: string
  stale?: WorktreeInfo
  fromRemote: boolean
  branch?: NonNullable<WorktreeRecovery['branch']>
  fresh: NonNullable<WorktreeRecovery['fresh']>
}

async function recreatePlan(path: string, savedBranch?: string): Promise<Plan> {
  const layout = checkoutLayout(path)
  if (!layout) throw new Error('This checkout is outside .phosphor/worktrees. Recreate it by hand.')
  const { repoPath, name } = layout
  const top = await git(repoPath, ['rev-parse', '--show-toplevel'], { trim: true }).catch(() => '')
  if (!top || normalizeRealPath(top) !== normalizeRealPath(repoPath))
    throw new Error(`The repository ${repoPath} is missing.`)
  const [worktrees, start, refs] = await Promise.all([
    listWorktrees(repoPath),
    startPoint(repoPath),
    branchRefs(repoPath),
  ])
  const stale = worktrees.find((w) => sessionPathKey(w.path) === sessionPathKey(path))
  if (stale?.locked)
    throw new Error('Git still has this checkout registered and locked. Run git worktree unlock.')
  const prefix = normalizePrefix(getPrefs().worktrees.branchPrefix)
  const elsewhere = new Set(worktrees.filter((w) => w !== stale).map((w) => w.branch))
  const available = [...new Set([...refs.local.keys(), ...refs.remote.keys()])].filter(
    (b) => b !== start.defaultBranch && !elsewhere.has(b),
  )
  const hints = [stale?.branch, savedBranch].filter((b): b is string => !!b && b !== '(detached)')
  const chosen = pickBranch({ name, prefix, hints, available })
  const ref = chosen && (refs.local.get(chosen) ?? refs.remote.get(chosen))
  const taken = (b: string) => refs.local.has(b) || refs.remote.has(b)
  let fresh = `${prefix}${name}`
  for (let n = 2; taken(fresh); n++) fresh = `${prefix}${name}-${n}`
  return {
    repoPath,
    name,
    stale,
    fromRemote: start.fromRemote,
    branch:
      chosen && ref ? { name: chosen, ...ref, remoteOnly: !refs.local.has(chosen) } : undefined,
    fresh: { base: start.base, branch: fresh },
  }
}

export async function worktreeRecovery(path: string): Promise<WorktreeRecovery> {
  const edited = await editedFiles(path)
  const result: WorktreeRecovery = {
    editedFiles: edited.slice(0, EDITED_FILES_SHOWN),
    editedFileCount: edited.length,
  }
  if (existsSync(path)) return { ...result, unavailable: 'This checkout already exists.' }
  const record = savedRecord(path)
  if (record) result.saved = { tip: record.tip, branch: record.branch }
  try {
    const plan = await recreatePlan(path, record?.branch)
    return { ...result, branch: plan.branch, fresh: plan.fresh }
  } catch (error) {
    return record ? result : { ...result, unavailable: errorText(error) }
  }
}

/** Recomputes the plan inside the workspace gate; the renderer only picks a source. */
export async function recreateWorktree(
  path: string,
  source: WorktreeRecreateSource,
): Promise<void> {
  if (source !== 'branch' && source !== 'fresh') throw new Error('Unknown checkout source.')
  await withWorkspace(path, async () => {
    if (existsSync(path)) throw new Error('This checkout already exists.')
    if (registry.list().some((s) => sessionPathKey(s.workspacePath) === sessionPathKey(path)))
      throw new Error('A session is already running in this checkout.')
    const plan = await recreatePlan(path, savedRecord(path)?.branch)
    if (source === 'branch' && !plan.branch)
      throw new Error('No single matching branch is available any more.')
    // `git worktree add` refuses a path that is missing but still registered.
    // The folder is gone (checked above), so this drops only Git's bookkeeping.
    if (plan.stale) await git(plan.repoPath, ['worktree', 'remove', '--force', plan.stale.path])
    await addWorktree(
      plan.repoPath,
      plan.name,
      source === 'branch'
        ? { kind: 'existing', branch: plan.branch!.name }
        : {
            kind: 'new',
            base: plan.fresh.base,
            branch: plan.fresh.branch,
            noTrack: plan.fromRemote,
          },
    )
    notifyWorkspaceSessions(path)
  })
}
