# 2026-08-26 — Auto-naming had never run, and starting a chat showed nothing

Two problems, reported together as "we never see the name change, and there is
a lag from hitting enter to seeing the session start up". They turned out to be
unrelated: one is a dead subprocess call, the other is a screen that does not
react to a keystroke.

## `pi -p` waits for stdin, and `execFile` never closes it

`pi:generateTitle` ran the naming prompt through `promisify(execFile)`.
`execFile` hands the child an open stdin pipe and never closes it, and `pi -p`
does not answer until stdin reaches EOF. So every naming request sat idle until
its `timeout: 30_000` fired, threw, and was swallowed by a `catch` that returned
`null`.

Same binary, same argv, same cwd, on the machine that reported this:

| how it is spawned                              | result                                 |
| ---------------------------------------------- | -------------------------------------- |
| `spawn(…, stdio: ['ignore','pipe','pipe'])`    | exit 0 in **8.8s**, a real title       |
| `execFile`                                     | **hangs**; killed at 30s, stdout empty |
| `spawn` with stdin open, closed by hand at 12s | idle 12s, then answers 6.9s later      |

The last row is the mechanism on its own: nothing is slow, pi is simply waiting.

The disk agrees. Across every Phosphor worktree session in
`~/.pi/agent/sessions/`, **no session file contains a `session_info` record**.
The only named sessions are the orchestrator's, which are spawned with `-n`.
Auto-naming had never worked with real pi, which is why every auto-created
branch was still a slug of its first message.

**The e2e suite could not have caught it.** `e2e/fixtures/pi-stub.cjs` answers
`-p` by writing a line and calling `process.exit(0)` without ever reading
stdin, so the stub is happy either way, and `smoke.spec.ts` has been asserting
a branch rename that only ever happened against the stub. This is the stub-vs-pi
divergence CLAUDE.md warns about, in its most expensive form: a green test for a
feature that has never once run.

The fix is `electron/pi/print-mode.ts` — a `spawn` with `stdio[0] = 'ignore'`,
which is the entire difference. `print-mode.test.ts` drives it with a
fixture that blocks on stdin the way pi does; that fixture times out under
`execFile` and passes under the new spawn, so it is a real regression guard
rather than a restatement. The handler now also logs the outcome of every
naming run: the failure mode here produced no symptom at all beyond "sessions
are never named", which names no cause.

Verified against real pi through the shipped code path (`runPrintMode` +
`titlePrompt` + `sanitizeTitle` + `dedupeTitle`), in a Phosphor worktree: 7.5s,
no error, `Friendly Greeting`.

### The name still had to reach the row

Fixing the subprocess is not enough. `SessionRow` read the title from the disk
scan, and **pi does not write a session file until a turn ENDS** (measured: no
file at all at t+0, t+500ms or t+3s; the whole file appears at once when the
first reply lands). A name set eight seconds into a five-minute turn therefore
could not appear for five minutes, while the top bar — which reads the chat
store — renamed immediately.

So a live session's own name now wins over the scanned one in the sidebar too.
The `refreshDisk` after `set_session_name` is kept, because it is the right
call in the one case where the turn has already settled; the folder watcher
covers the rest.

## Enter changed nothing on screen

`startChat` resolved a start point, fetched, created a worktree and spawned pi
before anything visible happened. The typed text stayed in the composer, the
greeting stayed up, and the only feedback was a 14px spinner in the composer's
corner. The labels written to narrate that wait ("Creating branch…") reached
`aria-label` and `title` and were never rendered — `startLabel` has now been
deleted rather than left as decoration.

Four changes, in order of how much they matter:

- **The send is committed on the keystroke.** `stores/startingChat.ts` holds
  the message, the composer clears, and `StartingChat` renders it in the same
  bubble, at the same width, in the same place the transcript will put it —
  measured across the swap, the bubble does not move vertically. One quiet
  status line names the step underneath.
- **The greeting no longer flashes the wrong folder.** `startChat` switches the
  open workspace to the new worktree before the session exists, and with
  `activeSessionId` still null the app fell through to the greeting screen,
  which re-rendered for the empty worktree ("Start your first session in
  hey-2") for a beat. The starting view covers that window.
- **The fetch is off the send path entirely.** `resolveBase` used to await a
  throttled `git fetch` on a 3s budget, so the first send after any pause paid
  a network round trip. `prefetchTrunk` now runs it when the home screen
  mounts — while the user is still typing — and the send reads whatever refs
  are there.
- **The two git reads overlap.** `git:startPoint` and the worktree/branch
  refresh are independent reads of the same repo and were serialized.

Measured on this repo (24 worktrees), the git work in front of a send:

| step                                  | before     | after              |
| ------------------------------------- | ---------- | ------------------ |
| `git fetch` (throttled, when it runs) | 0.83s      | 0                  |
| `git:startPoint`                      | 0.03s      | 0.03s ⎫            |
| worktree refresh (24 × `status`)      | 0.64s      | 0.64s ⎭ concurrent |
| `git worktree add`                    | 0.15s      | 0.15s              |
| **total**                             | **~1.65s** | **~0.79s**         |

The perceived wait is separately zero, because the screen changes on the
keystroke rather than at the end of that.

## Less motion, and chips that do not lie

- **One shimmer, not four.** `.name-pending` was applied by both sidebar row
  types, the top bar and the branch chip, so starting a chat set three or four
  continuous animations running in the two places the user was already
  watching change. Only the top bar's title shimmers now; the others carry the
  pending state in a tooltip and animate only the arrival. The rule is written
  into the `.name-pending` comment.
- **The sidebar row stops mutating twice.** `PendingSessionRow` showed
  "naming…" / "starting…" and was then replaced by a `SessionRow` showing
  `time · wt · branch`. Since the pending row now stands in for the whole first
  turn (see above), that swap was very visible. Both rows render the same
  subtitle through one `SubtitleSegments` component.
- **The branch is named once.** The sidebar's workspace switcher said
  `Phosphor (Phosphor/hey-2)` directly under a top bar whose chips already said
  `hey-2` and `phosphor/hey-2`. It uses the new `projectName` and says `Phosphor`;
  the window title keeps the long form, having nowhere else to put the branch.
- **"new branch" says what it branches from.** With isolation on, `startChat`
  always branches from trunk and ignores the branch chip beside the composer —
  which nonetheless showed the open folder's branch and read as the answer. The
  toggle now reads `new branch off main`, from the same `git:startPoint` call
  the send makes, so the label and the behaviour cannot disagree.

## A failed start no longer eats the message

Committing the send unmounts `WorkspaceHome`, which takes its `text`/`images`
state with it — so the old `catch` that restored the composer would have been
writing to a component that no longer existed. The draft is parked in
`startingChat` instead and picked up by the remounted greeting screen, scoped
to the folder it was composed in. A start that fails for a non-fatal reason
(git refused the branch, session started in the repo instead) now raises a
toast rather than an inline note under a composer that has already gone.

## Also fixed on the way

`git-worktrees.test.ts` failed on macOS on clean `main`, unrelated to any of
the above: the assertion matched a worktree on `path` alone, and on macOS the
temp dir is a symlink, so git reports `/private/var/...` where the test says
`/var/...`. Production lookups already match on `path || realPath`; the test
now does the same.

## One e2e guard was resting on the old latency

`reopens the last session on relaunch` waits for a sidebar row before closing
the app, because `lastSessionPath` is only persisted once `get_state` returns
the session's file. But `PendingSessionRow` carries the same `session-row`
testid, so a bare match was already satisfied before any file existed — the
guard proved nothing and only held because starting a chat was slow enough for
the disk write to win the race anyway. Taking ~0.9s of git off the send path
made it lose, and the test failed. It now waits for
`[data-testid="session-row"]:not([data-pending])`, which is the signal it
always meant.

## Tests

- `electron/pi/print-mode.test.ts` (new) — stdin-EOF fixture,
  non-zero exit, spawn failure. The first fails against `execFile`.
- `src/stores/startingChat.test.ts` (new) — the stand-in lifecycle, and the
  draft handed back on failure (including that a new send supersedes it).
- `src/lib/path.test.ts` — `projectName` never leaks the worktree or branch.
- Full unit suite, lint, typecheck and the 29-test e2e matrix all green.
