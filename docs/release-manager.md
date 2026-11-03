# Release manager

A lane in **release mode** is its repository's release manager. It keeps the
queue of open pull requests, validates and reviews each one, fixes what it can,
merges them one at a time and watches the release. The lanes that write the
pull requests only open them. GitHub is the queue and the only channel between
the manager and other lanes: the manager never messages another session
(AGENTS.md fact 5).

The extension is `libs/pi-extensions/pi-ext/release-manager.ts` and its
`release-*` helpers. The Host side is `apps/host/src/lanes/release-keeper.ts`, and the
composer switch is `ReleaseSwitch.tsx`.

## Setting a repository up

Release mode needs `.github/release-manager.md` on the repository's base branch.
The global `release-setup` skill, seeded into pi's skills like
`visual-artifacts`, writes it: run `/skill:release-setup` in a lane. It checks
GitHub access, rulesets, merge settings, workflows and validate commands, then
opens one setup pull request with the policy file and a "Pull requests" section
for the repository's AGENTS.md. It also creates the `rm:hold`, `rm:priority` and
`rm:blocked` labels and the pinned "Release queue" issue. Phosphor never writes a
repository's AGENTS.md itself: the user merges the setup pull request.

The policy's front matter:

| Key              | Read by       | Meaning                                                 |
| ---------------- | ------------- | ------------------------------------------------------- |
| `base`           | the extension | The branch pull requests merge into (default `main`)    |
| `merge`          | the extension | `squash` (default), `merge` or `rebase`                 |
| `required_check` | the manager   | The check that gates a merge                            |
| `validate`       | the manager   | The local command a merge-in or fix must pass           |
| `freshness`      | the manager   | `local`: merge the base in and validate; `ci`: rerun CI |
| `batch`          | the manager   | Pull requests per merge; `1`                            |
| `human_only`     | the manager   | Globs it validates and reviews but never merges         |

The body holds the repository's review rules. The extension reads `base` and
`merge` again from origin's base branch before every pass, so a policy change
applies once it merges, never from a lane's stale checkout.

## Switching it on

The composer shows a **Release** switch in any lane whose checkout has the
policy. It sends `/phosphor-release on` or `off`;
`/phosphor-release takeover` claims the lease from another lane. Release mode is
saved in the lane's session, so it survives a restart of the same session; a
fork starts with it off.

The switch publishes `phosphor-release`, a JSON status
(`libs/pi-extensions/pi-ext/release-status.ts`, import-free so the Host and
both clients parse it): `available`, `enabled`, `role` (`off`, `active`,
`standby`), the lease `holder` host and `epoch`, `quiet`, and the last
`problem` reaching GitHub. Lanes in repositories without the policy publish
nothing.

## One manager per repository: the lease

The ref `refs/phosphor/release` on origin holds an orphan commit with three
files: `lease.json` (holder, host, process, epoch, expiry), `memory.md` (at
most 16,384 characters) and `ledger.jsonl` (the last 500 events). Every write is
a compare-and-swap: `git push --force-with-lease=refs/phosphor/release:<sha read>`.
A lost race (git's `(stale info)`, or the server's `cannot lock ref`) reads the
ref again, so the standby names the lane that won; any other refusal is a
`problem`. A file the commit lacks reads as empty, but one it lists and cannot
read fails the read, so a passing glitch never looks like a free lease.

- The lease lasts 20 minutes and is renewed every 5. A new holder bumps the
  epoch and logs it in the ledger. If someone deletes the ref, the next holder
  starts again at epoch 1 with empty memory.
- The holder is a session on a host, run by one process. A second live process
  on the same session waits on standby. A restart on the same host finds its old
  process gone and takes the lease back at once, with a new epoch.
- Expiry compares each host's own clock with the time written in the lease.
  Hosts whose clocks disagree by minutes can take over early or late; keep
  them on network time.
- A lane that finds the lease held stays on **standby**: it answers the user
  and changes nothing on GitHub. It takes over once the lease lapses, or at
  once on `takeover`.
- Switching off hands the lease over immediately and keeps the memory.
- It needs only push access to the repository. Phosphor Control never sees it.

## Passes

While a lane holds the lease, the extension polls GitHub every 60 seconds
without calling a model: open pull requests with their heads, drafts, labels,
conflicts and check rollups, and the latest workflow runs on the base head. A
pass starts only when that digest changes, on the lane's first poll, or every
30 minutes while something is actionable. Each pass needs the lane idle, renews
the lease first, and arrives as a `phosphor-release-pass` message carrying the
changes, the queue facts, the memory and the last ten ledger events.

The manager's standing instructions are a request-local system prompt section,
`<phosphor_release>`, never persisted in the session. In a pass it rebuilds the
queue from GitHub, moves each pull request one step, merges at most one, and
never waits on CI inside a pass. It fixes CI failures and conflicts that the
diff and the log explain on the PR branch in a worktree of its own; for logic it
blocks the pull request (`rm:blocked`) and asks the user to resume that lane. A
pull request whose description records its own review gets a check of only what
its lane could not see; one without gets a fresh reviewer.

## Tools and the fence

Four tools are active only while the lane holds the lease:

| Tool             | Does                                                                                |
| ---------------- | ----------------------------------------------------------------------------------- |
| `release_merge`  | Checks the head and the policy, renews the lease, merges with `--match-head-commit` |
| `release_memory` | Saves memory or a ledger event, as the holder only                                  |
| `release_ask`    | Asks the user without pausing; silence applies the default after the wait           |
| `release_flag`   | Makes this pass alert the user when it ends                                         |

`release_merge` fetches the pull request's head with local git and refuses
unless it is still the commit reviewed. It refuses a change to the policy file,
renames and deletions included. Then it renews the lease by compare-and-swap,
so no other lane can take the lease between that check and the merge. A refused
renewal drops the lane to standby.

While release mode is on, a `tool_call` hook (`release-guard.ts`) refuses
merges through `bash`: `gh pr merge`, writes to the merge endpoints, and GraphQL
merge mutations. It also refuses pushes that force, mirror, prune or delete, and
any push to the base branch. It splits the command as a shell would, so quoted
text passes, and it looks into `sh -c`, `eval`, `$(…)` and wrappers such as
`env`. It is a guard against the lane's own mistakes, not a security boundary.

## Telling the user

- A routine pass ends quietly: `quiet` is set when a run starts from a pass or
  an answer, and cleared by a person's prompt or `release_flag`. The Host
  withholds its _finished_ alert and This Mac its settled notice for a quiet
  run. _Failed_ still alerts.
- A flagged pass (a revert, a takeover, a failed release) alerts as _finished_.
- `release_ask` opens a dialog: the lane shows _needs input_ and the OS
  notifies. The pass does not wait for it.

## The Host keep-alive

The one exception to "a lane resumes on its next message". The Host follows each
attached lane's `phosphor-release` status. A lane with release mode on is
recorded in `release-lanes.json` in the Host's state directory (at most 64). The
Host resumes recorded lanes when it starts, two seconds apart, and restarts one
after an unexpected exit, backing off from 30 seconds to 30 minutes; ten
minutes up resets the backoff, and eight failures in a row stop it. A deliberate
stop while the Host is ready (the user, an account move, a deletion) or release
mode switching off removes the record; the lane's next run with release mode on
records it again. Nothing restarts while the Host drains. It never calls a
model. Desktop lanes have no keep-alive.
