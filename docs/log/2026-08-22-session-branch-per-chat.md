# 2026-08-22 — One chat, one branch, one name

Sending the first message from the home composer now names the session, cuts
a branch off the latest trunk, and runs the session there. Previously a chat
started in whatever workspace happened to be open, so every session in a
project shared one branch and the sidebar showed the same branch on every row
— which is what prompted this work.

Naming and branching ship together because they are the same operation. pi
never titles a session, so Phosphor already asked a one-shot `pi -p` for a name
(see 2026-08-22-chat-polish-and-auto-naming.md); that title is now also what
the branch and the worktree folder are named after. Doing them separately
would have meant two model calls and two unrelated names for one piece of
work.

> **Superseded in part, same day, by
> [2026-08-22-fast-session-start.md](2026-08-22-fast-session-start.md).** The
> ordering below — name first, then branch, with the send blocking on the
> title — did not survive contact with the clock: `pi -p` measured ~13s against
> the 12s cap this document describes, so the title lost its own race on every
> run and the branch was always named after the message slug anyway. The branch
> is now cut first and renamed once the title lands. Everything else here
> (origin/trunk, `--no-track`, the name derivation, the one-flag-three-surfaces
> preference) still holds.

## The sequence, and why it blocks

`src/features/sessions/startChat.ts` owns the send path:

1. `git:info` on the open workspace → is this a repo, and which repo owns it
   (a worktree's repo of record is its `mainRepoPath`).
2. In parallel: `pi:generateTitle`, and a throttled `git:fetch` +
   `git:startPoint`.
3. `branchNameFor` → `{folder, branch}`, deduped against live branch and
   worktree lists.
4. `git:addWorktree` with the new branch, based on the start point.
5. Switch the open workspace to the worktree, then `createSession` there with
   `name` set.

The button waits (~2s, labelled "Naming session… / Creating branch…") because
a pi session is bound to the cwd it spawned in — it records its transcript
under a mangling of that path — so there is no moving a live session into a
worktree afterwards. The branch has to exist first.

Every step degrades instead of aborting: a naming timeout (12s cap) falls
back to slugging the message, an unreachable remote falls back to local
trunk, and a git refusal starts a plain session in the open folder with the
reason shown under the composer. The user's message is never lost to a
failure in any of this.

## `origin/main`, not `main`

The ask was "branch off the latest main, pull first if needed". Pulling is
the wrong tool: `git:pull` is fast-forward-only and refuses outright on a
dirty main tree, so a "new chat" button would fail exactly when the user has
work in progress. `startPoint` (git-worktrees.ts) fetches and branches from
`refs/remotes/origin/<trunk>` instead — freshest trunk, main checkout never
touched, dirty or not. Fallback ladder: `origin/<trunk>` → local `<trunk>` →
`HEAD`.

`--no-track` goes with it. Without it git adopts `origin/main` as the new
branch's upstream, so the chip would report the session as "behind trunk"
forever and a stray `git push` would aim at main. Distance from trunk is
already reported separately via `behindDefault`.

## Names

`src/lib/branchName.ts` is pure and tested: slugify (NFKD, `[a-z0-9-]`, word-
boundary truncation at 40), normalize the prefix (a bare `Phosphor` means
`phosphor/`; `Phosphor-` is left alone), then suffix past collisions in **both**
namespaces — a folder and its branch can be taken independently, and
creating one without the other leaves a chat whose sidebar group and branch
chip disagree.

The charset is deliberately narrower than git's ref rules, so nothing it can
emit needs re-validating: `..`, `@{`, `~^:?*[\`, a leading `-` and a trailing
`.lock` are all unreachable from `[a-z0-9-]` starting alphanumeric.

Folder and branch differ on purpose (`stub-session-title` vs
`phosphor/stub-session-title`): the prefix contains a `/`, and a `/` in the
folder name would nest the checkout and rename the sidebar group to the last
segment. `AddWorktreeBranch`'s `new` variant grew an optional `branch` for
this.

## One flag, three surfaces

`preferWorktree` now persists (`AppPrefs.worktrees`). It had reset to `true`
on every launch, which made it a preference the user could not actually turn
off. The branch popup's "worktree" checkbox, a new "new branch" checkbox on
the home composer, and a Settings → Workspaces toggle are all the same flag —
three surfaces asking "does my work get its own branch?" that must not be able
to disagree. The prefix lives beside it (default `phosphor/`, empty allowed).

The composer checkbox partially reverses the "no chips above the composer"
decision in WORKTREES.md, deliberately and narrowly: it does not pick a
target (the top bar still owns that), it opts one message out of isolation,
which is worth deciding per message.

## Tests

- `src/lib/branchName.test.ts` — derivation, including that no producible slug
  is a ref git would reject.
- `git-worktrees.test.ts` — branch-name-≠-folder, ref-hostile branch rejection,
  and a real clone proving a new branch starts from `origin/main` while local
  `main` is stale, plus that `--no-track` leaves the branch upstream-less.
- `e2e/smoke.spec.ts` — the worktree flow now asserts that a chat started from
  inside worktree `task-1` branches off trunk into `phosphor/stub-session-title`
  rather than continuing on `task-1`; a sibling test unticks the checkbox and
  asserts nothing is created. The stub answers the naming prompt with a fixed
  title and honours `-n`, which is what makes the branch name deterministic.

Two long-standing e2e tests ("reopens the last session on relaunch",
"sidebar groups sessions…") fail intermittently on this machine. Verified
pre-existing by stashing this work, rebuilding, and reproducing the same
failures on unmodified code — not caused by this change, but worth chasing.
