# 2026-08-28 — lane management, and artifacts you can edit without resending

Two features that turned out to share a root cause: doing a small thing was
costing the price of the whole thing. Editing an artifact resent the entire
document; deleting eight finished lanes meant eight context menus.

## Part 1 — `artifact_edit`

### The measurement

Producing one interactive HTML artifact and revising it twice cost **198,488
characters of tool-call arguments, ~55k output tokens.** The third call was a
75k-char full document sent to change nine lines of CSS.

`details` is not the problem. pi-ai's `convertToolResult`
(`api/anthropic-messages.js`) reads only `content`, `toolCallId` and
`isError` — the artifact payload riding in `details` never reaches the model
and costs nothing. **The entire cost is the arguments the model writes**, and
those live in the transcript permanently.

So the fix is the one Claude Code already makes for files: stop resending.

| the pending 9-line fix | chars  | ~tokens |
| ---------------------- | ------ | ------- |
| as `artifact_update`   | 74,742 | 20,761  |
| as `artifact_edit`     | 420    | 116     |

### What was added

- **`artifact_edit`** — `{id, old_string, new_string, replace_all?}`, with
  `Edit`'s semantics: exact match, unique unless `replace_all`, and a no-op is
  an error rather than a silent new version.
- **`artifact_read`** — the one artifact tool whose output enters the context
  window. Without it, an artifact is uneditable after compaction: there is no
  way to recover the current text to match `old_string` against.
- **`artifact_list`** — ids, types, versions, sizes. Never content.

`artifact_update` stays for genuine full rewrites, with its description
rewritten to say what it costs.

### Two bugs found on the way

**`String.replace` is not literal.** Even with a string pattern it expands
`$&`, `` $` ``, `$'` and `$1` in the _replacement_. A `new_string` containing
`$&` — CSS, shell, regex source — would have been silently corrupted. The edit
path now uses `indexOf` + `slice`; `replaceAll` uses `split`/`join`, which was
already safe. Caught by a test written before the implementation was trusted.

**`artifact_update` corrupted its own metadata.** It emitted `type: 'update'`
(a tool sentinel, not an artifact type) and defaulted `title` to the slug id.
`stores/artifacts.ts` carried a documented workaround for both. The extension
now carries the real type and previous title forward. The workaround stays —
sessions recorded before today still hold the sentinel — but its comment now
says so.

### State rebuild

`session_start` already walked history to recover version counters. It now
recovers **content** too, because an edit has to apply to the live text. It
also refuses to let the legacy `'update'` sentinel become an artifact type.

`pi-ext/artifacts.ts` had no test file — the only bundled extension without
one. It has 16 now.

## Part 2 — lane management

### PR status per lane

`electron/fs/gh-cli.ts` already existed, but `ghPrForBranch` is per-branch and
was only wired to the top-bar branch popup. Fanning it across a sidebar is
8-20 `gh` subprocesses per refresh.

Added **`ghPrsForRepo`** → `gh:prsForRepo`, one subprocess per repo, indexed by
`headRefName`. The precedent is in the tree already: `git:info` grew
`git:infoBatch` for exactly this reason. Both queries now share one
`toPullRequest` shaping function so they cannot diverge.

`stores/pullRequests.ts` keys by repo path and coalesces: no refetch inside
`PR_STALE_MS`, none while one is in flight, none at all when `gh` is missing.
Refresh is event-driven — window focus and the disk listing changing — and only
for **expanded** groups, matching the session-dir watchers.

The chip is **one token carrying two signals**: colour is the PR state, glyph
is the check/review verdict. A second chip would double the ink on the densest
line in the app and truncate the branch to nothing. Two decisions worth
recording:

- **Terminal states beat check state.** A merged PR whose last run was red is
  still merged; colouring it red sends you to fix a branch that is already in.
- **Merged needed a new token.** `--px-merged` (violet). In `--px-success`,
  "merged" and "open and green" are indistinguishable — and those are the two
  states the sidebar is scanned to tell apart, because merged is the "this lane
  is done, delete it" signal. That is what makes PR status and bulk delete one
  feature rather than two.

### Lane markers

An emoji in a fixed 18px slot left of the title. Both rules are about the
column, not the glyph:

1. **Every lane has one**, because a slot that collapses shifts every title and
   the left edge goes ragged — which is the thing the column exists to prevent.
2. **The fallback is derived, not stored.** `SessionMeta` is scanned out of
   pi's own `.jsonl`; Phosphor does not own that format and must not add fields to
   it. Explicit choices go in `AppPrefs.laneMarkers` keyed by session path
   (beside `pinnedSessions` / `seenSessions`); everything else hashes the
   **branch**. Not the title: Phosphor names a session only after its first turn
   ends, so a title-derived marker would change under the user the moment the
   auto-namer landed.

Because the fallback is total, the override map is safe to prune — a dropped
entry degrades a lane to its auto marker, never to a blank row.
`PendingSessionRow` renders the slot too, or the swap to a real row mid-turn
would shift the title.

### Multi-select and bulk delete

Selection is scoped to **one group**, which is exactly one repo. A destructive
confirm spanning two repos is how you delete the wrong branch. The Pinned list
mixes projects, so it is not selectable at all.

The checkbox **replaces the indicator dot in the same gutter**, so entering
select mode shifts nothing, and it is revealed on hover rather than occupying
a permanent column.

Almost none of the destructive plumbing was new. `sessions:delete` already
trashes the pi transcript _and_ the paired Claude Code transcript via
`shell.trashItem`; `git:removeWorktree` already refuses a dirty tree and offers
only `git branch -d`. `RemoveWorktreeModal` is the single-lane version of the
confirm, and the two must keep agreeing about what "dirty" blocks.

Four things the confirm gets right on purpose:

- **Two tiers.** A _blocker_ (a turn in progress) refuses. A _warning_
  (uncommitted, unpushed, open PR) raises **one** acknowledgement for the whole
  selection — a per-lane confirm trains you to click through it.
- **Warnings on refused lanes do not count.** They are not being deleted.
- **Worktree removal happens before the transcript delete.** Worktree removal
  is the step that actually fails — a terminal cwd'd into the lane. Failing
  first leaves the lane whole and still in the sidebar; the other order leaves
  a transcript in the Trash and a directory on disk.
- **Sequential, and failures are reported.** A row that silently stays put
  reads as the delete having worked and the UI being stale.

**Remote branch deletion was deliberately not built.** No channel exists for
it, and a bulk flow is the worst place to introduce the least reversible
operation.

## Part 3 — artifacts can now run JavaScript

`ArtifactsPane.tsx` rendered html artifacts as `<iframe sandbox="allow-scripts"
srcDoc={content}>`. That looked like it permitted scripts and did not: a
`srcdoc` document **inherits the embedder's policy container**, and
`src/index.html` sets `script-src 'self'`. Every inline script was refused and
the sandbox attribute was a no-op. An interactive artifact rendered as a page
of empty boxes where its scripted regions should have been.

`blob:` and `data:` are no help — HTML treats them as local schemes and they
inherit the same way. Only a real, non-local scheme gets its own policy, so the
document has to be **served** rather than embedded.

`electron/artifacts/artifact-protocol.ts` registers `phosphor-artifact://` as a
standard, secure scheme and serves staged HTML with its own
`default-src 'none'` policy. The iframe keeps `sandbox="allow-scripts"` and
deliberately still omits `allow-same-origin`, which is what keeps the
document's security origin opaque.

### Measured, not assumed

Everything below was verified against a throwaway Electron 43 app driving the
real `src/index.html` policy and the exact CSP string this module ships:

| vector                             | before (`srcdoc`)      | after              |
| ---------------------------------- | ---------------------- | ------------------ |
| inline script                      | **blocked** (the bug)  | **runs**           |
| `window.origin`                    | —                      | `"null"` (opaque)  |
| `localStorage`, `document.cookie`  | —                      | `SecurityError`    |
| parent DOM, sibling artifact DOM   | —                      | `SecurityError`    |
| `top.location =`                   | —                      | `SecurityError`    |
| `fetch` / `sendBeacon` / WebSocket | inherited `'self' ws:` | blocked by CSP     |
| remote `<img>`                     | inherited `'self'`     | blocked by CSP     |
| form POST                          | —                      | blocked by sandbox |

**An artifact gains scripting and loses all network reach.** Under the old
inherited policy it had `connect-src 'self' ws:` and simply no way to use it.
Net, this reduces what model-authored HTML can do.

Two traps worth recording for anyone re-testing this:

- **`sendBeacon` returning `true` and `new WebSocket()` not throwing are false
  negatives.** Both queue and are refused asynchronously. Trust the console
  violations, not the return values.
- **`location.origin` is not the security origin.** It reports
  `phosphor-artifact://doc` even when the document is opaque. `window.origin` is
  the one that says `"null"`.

A form POST is a _navigation_, so `connect-src` does not cover it. It is
blocked by the sandbox (`allow-forms` unset) with `form-action 'none'` behind
it as an independent second layer.

### The CSP line did change

`frame-src` in `src/index.html` gained `phosphor-artifact:`. That is the one
widening, and it is what CLAUDE.md's "never widen this" was guarding. It was
made deliberately, with the containment above measured first, because the
alternative was a feature that silently did not work.

`HtmlBlock.tsx` (the ` ```html ` preview toggle) had the identical bug and now
goes through the same `SandboxedHtml` component.

**The browser-only harness (`npm run dev:web`) still cannot run artifact JS.**
It has no custom protocol, so the mock falls back to a blob URL, which inherits
the page CSP. Only the Electron app executes artifact scripts.
