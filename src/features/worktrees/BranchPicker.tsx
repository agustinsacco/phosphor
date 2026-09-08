import { useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import type { BranchInfo, WorktreeInfo } from '@shared/models'
import { MenuRow } from '@/components/PopupMenu'
import { CheckIcon, Spinner } from '@/components/icons'
import { Button, TextInput } from '@/components/form'
import { useAsyncAction } from '@/components/useAsyncAction'
import { repoWorktrees, useWorktreesStore } from '@/stores/worktrees'
import { workspaceName } from '@/lib/path'

/**
 * The branch/worktree picker body, shared by the top bar and the home composer.
 *
 * The two callers differ only in what "select" means — the top bar switches the
 * open workspace, the home composer records where the *next* session will start
 * — so the action is injected and everything else is identical.
 *
 * Shape follows Claude Desktop: one searchable list of every branch, with a
 * "worktree" checkbox deciding whether a pick gets its own checkout or takes
 * over the main tree's. The old menu capped the branch list at 8 with no search
 * and hid worktree creation behind a "New worktree…" row, which meant that on
 * any repo with real branch history the branch you wanted simply wasn't there.
 *
 * The checkbox is load-bearing for safety, not just convenience: unchecked, a
 * pick runs `git checkout` in the main tree, so it is guarded on a clean tree
 * and on no other worktree already holding the branch (see git-sync.ts).
 */
export function BranchPicker({
  repoPath,
  currentCwd,
  mainBranch,
  onSelectMain,
  onSelectWorktree,
  onRemove,
  onBusyError,
}: {
  repoPath: string
  /** Worktree path currently selected, or null when the main tree is. */
  currentCwd: string | null
  /** Branch shown on the "Main" row; defaults to the main worktree's branch. */
  mainBranch?: string
  onSelectMain: () => void
  onSelectWorktree: (worktree: WorktreeInfo) => void
  onRemove: (worktree: WorktreeInfo) => void
  onBusyError?: (message: string | null) => void
}): React.JSX.Element {
  const repo = useWorktreesStore((s) => repoWorktrees(s, repoPath))
  const preferWorktree = useWorktreesStore((s) => s.preferWorktree)
  const [query, setQuery] = useState('')
  const [creating, setCreating] = useState(false)
  const [newName, setNewName] = useState('')
  const [base, setBase] = useState('')
  // Thrown failures are also handed to the caller's banner; the "it returned a
  // reason" branches below only fill this picker's own error line.
  const {
    busy,
    error,
    setError,
    run: runAction,
  } = useAsyncAction((message) => onBusyError?.(message))
  const [notice, setNotice] = useState<string | null>(null)

  useEffect(() => {
    void useWorktreesStore.getState().refresh(repoPath)
    // Opening the menu is the moment the user cares whether they are behind, so
    // it is also the moment to ask the remote. Throttled in main, so a user
    // opening and closing this repeatedly costs one network round trip.
    void useWorktreesStore.getState().syncRemote(repoPath)
  }, [repoPath])

  const run = (action: () => Promise<void>): Promise<void> => {
    setNotice(null)
    return runAction(action)
  }

  const linked = repo.worktrees.filter((w) => !w.isMain)
  const mainWorktree = repo.worktrees.find((w) => w.isMain)
  const mainLabel = mainBranch ?? mainWorktree?.branch ?? repo.defaultBranch
  const prunable = repo.worktrees.some((w) => w.prunable)
  const byName = useMemo(() => new Map(repo.branches.map((b) => [b.name, b])), [repo.branches])

  const matches = (text: string): boolean =>
    !query.trim() || text.toLowerCase().includes(query.trim().toLowerCase())

  const visibleWorktrees = linked.filter((w) =>
    matches(`${workspaceName(w.path)} ${w.branch ?? ''}`),
  )
  /**
   * Branches not already represented by a row above. Trunk is excluded because
   * the "Main tree" row is how you get to it, and branches that already have a
   * worktree appear in the Worktrees section instead of twice.
   *
   * Unlike the old menu this is neither capped nor filtered down to branches
   * git considers "free": with the checkbox off, a branch that is checked out
   * in the main tree is still a legitimate thing to select.
   */
  const visibleBranches = repo.branches.filter(
    (b) => !b.worktreePath && b.name !== repo.defaultBranch && matches(b.name),
  )

  /** Selecting a branch: isolate it in a worktree, or check it out in place. */
  const selectBranch = (branch: BranchInfo): Promise<void> =>
    run(async () => {
      const store = useWorktreesStore.getState()
      if (preferWorktree) {
        const created = await store.addWorktree(repoPath, branch.name.replace(/\//g, '-'), {
          kind: 'existing',
          branch: branch.name,
        })
        onSelectWorktree(created)
        return
      }

      const result = await store.checkout(repoPath, branch.name)
      if (result.checkedOut) {
        onSelectMain()
        return
      }
      setError(
        result.reason === 'dirty'
          ? `The main tree has ${result.dirtyCount} uncommitted change${result.dirtyCount === 1 ? '' : 's'}. Commit or stash them, or tick "worktree" to leave the main tree alone.`
          : `"${branch.name}" is checked out in ${workspaceName(result.worktreePath)}. Open that worktree, or tick "worktree" to get another checkout.`,
      )
    })

  const create = (): Promise<void> =>
    run(async () => {
      const name = newName.trim()
      if (!name) return
      // Caught here rather than in git's own words: `worktree add -b` fails with
      // "a branch named 'x' already exists", which doesn't say what to do next.
      const clash = byName.get(name)
      if (clash) {
        setError(
          clash.worktreePath
            ? `Branch "${name}" already has a worktree. Pick it from the list above.`
            : `Branch "${name}" already exists. Pick it from the list above, or choose a new name.`,
        )
        return
      }
      const created = await useWorktreesStore
        .getState()
        .addWorktree(repoPath, name, { kind: 'new', base: base || 'HEAD' })
      setCreating(false)
      setNewName('')
      onSelectWorktree(created)
    })

  const pullMain = (): Promise<void> =>
    run(async () => {
      const result = await useWorktreesStore.getState().pull(repoPath, repoPath)
      if (result.pulled) {
        setNotice(
          `Pulled ${result.commits} commit${result.commits === 1 ? '' : 's'} from ${result.upstream}.`,
        )
      } else if (result.reason === 'dirty') {
        setError(
          `The main tree has ${result.dirtyCount} uncommitted change${result.dirtyCount === 1 ? '' : 's'} — commit or stash before pulling.`,
        )
      } else if (result.reason === 'diverged') {
        setError(
          `Your ${mainLabel} has ${result.ahead} commit${result.ahead === 1 ? '' : 's'} that ${result.upstream} does not, so this can't fast-forward. Merge or rebase manually.`,
        )
      } else if (result.reason === 'no-upstream') {
        setError(`${mainLabel} has no upstream branch to pull from.`)
      } else {
        setNotice('Already up to date.')
      }
    })

  const refreshFromMain = (worktree: WorktreeInfo): Promise<void> =>
    run(async () => {
      const result = await useWorktreesStore.getState().updateFromMain(repoPath, worktree.realPath)
      if (result.updated) {
        setNotice(
          `Merged ${result.commits} commit${result.commits === 1 ? '' : 's'} from ${repo.defaultBranch}.`,
        )
      } else if (result.reason === 'dirty') {
        setError(
          `${workspaceName(worktree.path)} has ${result.dirtyCount} uncommitted change${result.dirtyCount === 1 ? '' : 's'} — commit them first.`,
        )
      } else if (result.reason === 'conflict') {
        setError(
          `Merge conflicts in ${result.conflicts.length} file${result.conflicts.length === 1 ? '' : 's'} — the merge was aborted, resolve it in a terminal.`,
        )
      } else {
        setNotice('Already up to date with ' + repo.defaultBranch + '.')
      }
    })

  const mainInfo = byName.get(mainLabel)
  const mainBehind = mainInfo?.behind ?? 0

  return (
    <>
      <div className="px-2 pb-1.5 pt-1">
        <TextInput
          autoFocus
          size="sm"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="Search branches…"
          className="w-full"
        />
      </div>

      <WorktreeToggle
        checked={preferWorktree}
        busy={repo.fetching}
        onChange={(value) => useWorktreesStore.getState().setPreferWorktree(value)}
      />

      <MenuRow
        active={false}
        disabled={busy}
        onClick={onSelectMain}
        title={`The main working tree — where ${mainLabel || 'the default branch'} lives`}
      >
        <span className="min-w-0 flex-1 truncate text-lg">
          Main tree — <span className="font-mono text-base">{mainLabel}</span>
          {(mainWorktree?.dirtyCount ?? 0) > 0 && (
            <span className="text-warning"> ±{mainWorktree?.dirtyCount}</span>
          )}
          {mainBehind > 0 && (
            <span className="text-info" title={`${mainBehind} commits on ${mainInfo?.upstream}`}>
              {' '}
              ↓{mainBehind}
            </span>
          )}
        </span>
        {currentCwd === null && <CheckIcon className="text-accent shrink-0" />}
      </MenuRow>

      {mainBehind > 0 && (
        <InlineAction
          busy={busy}
          label={`Pull ${mainBehind} commit${mainBehind === 1 ? '' : 's'} from ${mainInfo?.upstream ?? 'the remote'}`}
          onClick={() => void pullMain()}
        />
      )}

      {visibleWorktrees.length > 0 && (
        <>
          <SectionHeading>Worktrees</SectionHeading>
          {visibleWorktrees.map((wt) => {
            const behindMain = wt.branch ? byName.get(wt.branch)?.behindDefault : undefined
            return (
              <div key={wt.path}>
                <MenuRow active={false} disabled={busy} onClick={() => onSelectWorktree(wt)}>
                  <span className="min-w-0 flex-1 truncate text-lg" title={wt.path}>
                    {workspaceName(wt.path)}
                    <span className="text-text-tertiary font-mono text-sm">
                      {' '}
                      {wt.branch ?? wt.head.slice(0, 8)}
                    </span>
                    {wt.dirtyCount > 0 && <span className="text-warning"> ±{wt.dirtyCount}</span>}
                    {wt.prunable && <span className="text-danger"> missing</span>}
                  </span>
                  {currentCwd === wt.realPath && <CheckIcon className="text-accent shrink-0" />}
                  {/* span, not button: MenuRow itself renders a <button>. */}
                  <span
                    role="button"
                    tabIndex={0}
                    onClick={(e) => {
                      e.stopPropagation()
                      onRemove(wt)
                    }}
                    title="Remove worktree…"
                    className="text-text-tertiary hover:text-danger shrink-0 px-1"
                  >
                    ✕
                  </span>
                </MenuRow>
                {behindMain !== undefined && behindMain > 0 && !wt.prunable && (
                  <InlineAction
                    busy={busy}
                    label={`${behindMain} commit${behindMain === 1 ? '' : 's'} behind ${repo.defaultBranch} — update`}
                    onClick={() => void refreshFromMain(wt)}
                  />
                )}
              </div>
            )
          })}
        </>
      )}

      {visibleBranches.length > 0 && (
        <>
          <SectionHeading>
            {preferWorktree ? 'Branches (opens as worktree)' : 'Branches (checks out in main tree)'}
          </SectionHeading>
          {visibleBranches.map((branch) => (
            <MenuRow
              key={branch.name}
              active={false}
              disabled={busy}
              onClick={() => void selectBranch(branch)}
              title={branch.lastCommitSubject}
            >
              <span className="min-w-0 flex-1 truncate font-mono text-base">{branch.name}</span>
              {branch.isCurrent && <CheckIcon className="text-accent shrink-0" />}
              {(branch.behind ?? 0) > 0 && (
                <span className="text-info shrink-0 text-sm">↓{branch.behind}</span>
              )}
              {(branch.ahead ?? 0) > 0 && (
                <span className="text-success shrink-0 text-sm">↑{branch.ahead}</span>
              )}
            </MenuRow>
          ))}
        </>
      )}

      {query.trim() && visibleWorktrees.length === 0 && visibleBranches.length === 0 && (
        <div className="text-text-tertiary px-3 py-2 text-base">
          No branch matches “{query.trim()}”.
        </div>
      )}

      <div className="border-border my-1 border-t" />

      {creating ? (
        <div className="space-y-1.5 px-3 py-1.5">
          <TextInput
            autoFocus
            size="sm"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') void create()
            }}
            placeholder="new branch name"
            className="w-full font-mono"
          />
          <select
            value={base}
            onChange={(e) => setBase(e.target.value)}
            className="border-border bg-surface text-text-secondary w-full rounded-md border px-2 py-1 text-base outline-none"
          >
            {/* Trunk first: branching off the default branch is the common
                case, and it reads better than the opaque "current HEAD". */}
            {repo.defaultBranch && (
              <option value={repo.defaultBranch}>base: {repo.defaultBranch} (default)</option>
            )}
            <option value="">base: current HEAD</option>
            {repo.branches
              .filter((b) => b.name !== repo.defaultBranch)
              .map((b) => (
                <option key={b.name} value={b.name}>
                  base: {b.name}
                </option>
              ))}
          </select>
          <Button
            variant="primary"
            size="sm"
            onClick={() => void create()}
            disabled={busy || !newName.trim()}
            className="w-full"
          >
            {busy ? 'Creating…' : 'Create worktree'}
          </Button>
        </div>
      ) : (
        <MenuRow
          active={false}
          disabled={busy}
          onClick={() => {
            setNewName(query.trim())
            setCreating(true)
          }}
        >
          <span className="text-lg">
            New branch{query.trim() && <span className="font-mono"> “{query.trim()}”</span>}…
          </span>
        </MenuRow>
      )}

      {prunable && (
        <MenuRow
          active={false}
          disabled={busy}
          onClick={() => void useWorktreesStore.getState().prune(repoPath)}
        >
          <span className="text-text-secondary text-lg">Prune stale worktrees</span>
        </MenuRow>
      )}

      {notice && <div className="text-text-secondary px-3 py-1 text-sm">{notice}</div>}
      {error && <div className="text-danger px-3 py-1 text-sm">{error}</div>}
    </>
  )
}

/**
 * The isolation switch. Rendered as a real checkbox rather than two menu rows
 * because it is a mode that persists across picks, not a one-off action — the
 * next branch you click behaves differently depending on it, and that has to be
 * visible at the moment of clicking.
 */
function WorktreeToggle({
  checked,
  busy,
  onChange,
}: {
  checked: boolean
  busy: boolean
  onChange: (value: boolean) => void
}): React.JSX.Element {
  return (
    <label
      className="hover:bg-bg-secondary mx-2 mb-1 flex cursor-pointer items-center gap-2 rounded-md px-1.5 py-1.5 transition-colors"
      title={
        checked
          ? 'Each branch you pick gets its own checkout under .phosphor/worktrees — your main tree is never touched.'
          : 'Picking a branch checks it out in the main tree. Refused if the tree has uncommitted changes.'
      }
    >
      <input
        type="checkbox"
        checked={checked}
        onChange={(e) => onChange(e.target.checked)}
        className="accent-[var(--px-accent)]"
      />
      <span className="text-text min-w-0 flex-1 text-base font-medium">worktree</span>
      {busy && <Spinner className="text-text-tertiary" />}
      <span className="text-text-tertiary shrink-0 text-sm">
        {checked ? 'isolated checkout' : 'checks out in place'}
      </span>
    </label>
  )
}

/** Sub-row action attached to the row above it (pull, update-from-main). */
function InlineAction({
  label,
  busy,
  onClick,
}: {
  label: string
  busy: boolean
  onClick: () => void
}): React.JSX.Element {
  return (
    <button
      onClick={onClick}
      disabled={busy}
      className={clsx(
        'text-info hover:bg-bg-secondary block w-full px-3 py-1 pl-6 text-left text-sm transition-colors disabled:opacity-50',
      )}
    >
      ↓ {label}
    </button>
  )
}

function SectionHeading({ children }: { children: React.ReactNode }): React.JSX.Element {
  return (
    <div className="text-text-tertiary px-3 pb-0.5 pt-1.5 font-mono text-xs uppercase tracking-wide">
      {children}
    </div>
  )
}
