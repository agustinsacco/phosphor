# Performance findings — RPC + streaming hot path

Read-only audit of memory and CPU on the pi → main → renderer streaming path.
Baseline: commit `b57688c`, `npm test` green (72 files / 746 tests) before and
after the audit. No source was modified.

Every finding is labelled **MEASURED** (a benchmark or a real artifact in this
repo / on this machine backs the number) or **REASONED** (an argument from the
code, no number). Benchmarks were run out-of-tree against esbuild bundles of the
real modules; node v22.22.0, Linux.

Two claims made by comments in the codebase turned out to be **false**
(F5, F6) and one turned out to be **true but obsolete** (F5's upstream
counterpart). Those are listed first among the high-severity items.

> **Status re-verified 2026-08-27** against the tree at `4c02e13`, finding by
> finding, by reading the cited code rather than trusting this document.
> Result: **17 open, 1 fixed, 1 moot.** The audit is essentially unactioned —
> treat the `open` rows as a live backlog, not as history.
>
> - **F14 fixed.** `electron/fs/git-info.ts` now has a TTL cache plus in-flight
>   dedupe behind `git:infoBatch`, landed with the P12 sidebar work.
> - **F15 moot.** Its cost was the floating monitor window, which no longer
>   exists. Push channels still fan out over `BrowserWindow.getAllWindows()`,
>   but there is no second window to pay for it.
>
> **2026-09-01** — F7, F8, F10, F16 and F17 fixed by the session resource
> work (its S1/S5/S4/S2/S6), logs
> [2026-09-01-session-scan-and-ipc-trims.md](../../log/2026-09-01-session-scan-and-ipc-trims.md)
> and
> [2026-09-01-session-reaper-and-live-stats.md](../../log/2026-09-01-session-reaper-and-live-stats.md).
>
> Status values: `open` (reproduces today) · `fixed` (with the commit or file
> that fixed it) · `moot` (the code it described is gone). Keep this column
> current — a finding list with no status is what made this file 956 lines of
> unknowns.

> **2026-08-26** — the Usage view and the resource monitor were deleted (see
> [log/2026-08-26-remove-usage-and-resources.md](../../log/2026-08-26-remove-usage-and-resources.md)).
> Findings below that rest on them are moot: F15's floating-monitor clause,
> F17's `usageSummary()` sizing note, and the monitor entry under "What is
> already correct". Everything else stands.

---

## Summary

| #   | Status    | Finding                                                                                               | Sev  | Evidence                                                                                            | Location                                                                                                                                                         |
| --- | --------- | ----------------------------------------------------------------------------------------------------- | ---- | --------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| F1  | open      | PTY scrollback re-copies 256 KB on **every** data chunk                                               | high | MEASURED 938 ms → 1.3 ms per 10 k chunks                                                            | `electron/pty/pty-manager.ts:67-69`                                                                                                                              |
| F2  | open      | Whole `tools` record cloned on every tool-args / tool-output delta                                    | high | MEASURED 288 µs/event @1600 tools vs 0.85 µs for text                                               | `src/features/chat/reducer.ts:379-385`, `:162-175`, `src/features/chat/toolIdentity.ts:165-168`                                                                  |
| F3  | open      | `buildTranscriptRows` rebuilds the whole transcript per token, defeating `memo` on every visible row  | high | MEASURED 98 µs/event @3001 items; 14 000 vs 500 component renders / 500 tokens                      | `src/features/chat/MessageList.tsx:53`                                                                                                                           |
| F4  | open      | `summarizeTool` re-`JSON.parse`s the entire accumulated args on every delta (O(n²))                   | high | MEASURED 665 ms for one 488 KB `write`                                                              | `src/features/chat/tools/toolSummaries.ts:80`                                                                                                                    |
| F5  | fixed     | `shared/rpc.ts` `message_update` mirrors a **pre-0.84.0** pi; all `partial` handling is dead code     | high | VERIFIED against pi 0.84.4 + its CHANGELOG + `docs/rpc.md`; see `specs/log/2026-08-28-pi-compat.md` | `shared/rpc.ts` header, `src/features/chat/toolIdentity.ts` (`revealedFromStart`), `reducer.ts` `toolcall_start`                                                 |
| F6  | open      | `releaseWorkspace` — the documented fix for editor/Monaco retention — is **never called**             | high | VERIFIED: only callers are its own test                                                             | `src/stores/files.ts:197`                                                                                                                                        |
| F7  | **fixed** | Live pi subprocesses are unbounded and only disposed by explicit user action                          | high | MEASURED 172 MB RSS for one _idle_ pi tree                                                          | `src/stores/sessions.ts:433-491`                                                                                                                                 |
| F8  | **fixed** | 28–49 `get_session_stats` RPC round trips per user turn; `usage` now arrives free on every delta      | med  | MEASURED against two real session files                                                             | `src/stores/sessions.ts:15-22,219-221`                                                                                                                           |
| F9  | open      | `JsonlDecoder` is O(n²) when one record spans many stdout chunks                                      | med  | MEASURED 959 ms for a 15.3 MB record; fix 17.6 ms                                                   | `electron/pi/jsonl.ts:19-31`                                                                                                                                     |
| F10 | **fixed** | `agent_end.messages` / `turn_end.toolResults` are serialized across IPC and then discarded            | med  | MEASURED 0.19–1.92 MB and 1–2 ms per run                                                            | `electron/ipc/pi-session-handlers.ts:95`, `src/features/chat/reducer.ts:82-112`                                                                                  |
| F11 | open      | `message_end` fold is O(items + tools); pi emits one message per tool call ⇒ O(n²) per session        | med  | MEASURED 616 µs @4000 items / 2000 tools                                                            | `src/features/chat/reducer.ts:505,526`                                                                                                                           |
| F12 | open      | `FilesChangedPane` re-derives every touched file (re-parsing every patch) on every tool delta         | med  | MEASURED 208–972 µs per recompute                                                                   | `src/features/files/FilesChangedPane.tsx:27-30`                                                                                                                  |
| F13 | open      | Artifact `versions[]` grows unbounded, full content per version, duplicated with the tool payload     | med  | REASONED                                                                                            | `src/stores/artifacts.ts:109,122`                                                                                                                                |
| F14 | **fixed** | `git:info` is uncached: 4 `git` spawns per debounced `fs:changed`                                     | med  | MEASURED 18 ms median on this repo                                                                  | `electron/ipc/git-handlers.ts:24`, `src/features/worktrees/BranchControl.tsx:38`                                                                                 |
| F15 | moot      | Every push channel broadcasts to **all** BrowserWindows, including the monitor float                  | med  | REASONED                                                                                            | `electron/pty/pty-manager.ts:189-193`, `electron/fs/workspace-watcher.ts:111-115`, `electron/pi/session-watcher.ts:26-30`, `electron/resources/monitor.ts:34-36` |
| F16 | **fixed** | A renderer reload orphans every live pi; `pi:listLiveSessions` exists to fix this and is never called | med  | VERIFIED: zero renderer callers                                                                     | `electron/ipc/pi-session-handlers.ts:126`                                                                                                                        |
| F17 | **fixed** | `metaCache` in the session scanner is unbounded and never evicts deleted files                        | low  | REASONED                                                                                            | `electron/pi/session-scanner.ts:28`                                                                                                                              |
| F18 | open      | `ArtifactsPane` runs `clearUnseen` (a `set`) on every render — no dep array                           | low  | REASONED                                                                                            | `src/features/artifacts/ArtifactsPane.tsx:33-35`                                                                                                                 |
| F19 | open      | The captured e2e/reducer fixture uses the pre-0.84.0 wire shape, so no test can catch F5              | low  | MEASURED: 94.2 % of the fixture's bytes are fields pi no longer sends                               | `src/features/chat/__fixtures__/real-session-events.jsonl`                                                                                                       |

An **ALREADY FINE** list of everything checked and found healthy is at the end.
Read it before re-investigating anything.

---

## F1 — PTY scrollback re-copies the whole 256 KB cap on every chunk

**Severity: high · MEASURED · `electron/pty/pty-manager.ts:67-69`**

```ts
const next = session.scrollback + data
session.scrollback =
  next.length > SCROLLBACK_LIMIT ? next.slice(next.length - SCROLLBACK_LIMIT) : next
```

**Cost, and when it is paid.** Once a shell has produced 256 KB of output — which
`npm run build`, a test run, or a `tail -f` reaches in seconds — every subsequent
`pty.onData` chunk builds a cons string and then flattens it back down to
256 KB. The trim is unconditional, so the cost is one full 256 KB copy per
chunk, in the **main process**, on the same thread that pumps pi's stdout and
services every `ipcMain.handle`.

Measured (steady state at the cap, 10 000 chunks):

| variant                               | 80-byte chunks | 4 KB chunks |
| ------------------------------------- | -------------- | ----------- |
| current (`slice` every chunk)         | **938 ms**     | **961 ms**  |
| amortized (`slice` only above 2× cap) | 1.3 ms         | 27.0 ms     |
| chunk deque, `join` on `attach()`     | 1.9 ms         | 0.2 ms      |

That is ~95 µs of main-process CPU **per chunk**, i.e. ≈2.6 GB/s of pure string
copying. A build that emits 10 000 chunks costs about one full second of blocked
main thread, spread across the run — which shows up as stuttering chat streaming
and laggy IPC while a terminal is busy.

**Fix.** Amortize the trim:

```ts
session.scrollback += data
if (session.scrollback.length > SCROLLBACK_LIMIT * 2) {
  session.scrollback = session.scrollback.slice(-SCROLLBACK_LIMIT)
}
```

or keep a deque of chunks with a running byte count and `join('')` only in
`attach()`. The deque is strictly better for large chunks and makes `attach()`
the only place that materializes the string.

**Risk of the fix: very low.** `attach()` is the only reader, and its documented
contract ("a superset of everything already broadcast") is preserved by both
variants. The amortized form keeps up to 512 KB per PTY instead of 256 KB —
double the cap, still bounded. The deque form keeps exactly the cap. There is no
existing test for scrollback trimming, so add one alongside.

---

## F2 — The whole `tools` record is cloned on every streaming tool delta

**Severity: high · MEASURED · `src/features/chat/reducer.ts:379-385` (`toolcall_delta`), `:162-175` (`tool_execution_update`), `src/features/chat/toolIdentity.ts:165-168`**

```ts
// reducer.ts:379 — one per toolcall_delta, i.e. per token of tool arguments
return {
  ...base,
  tools: {
    ...base.tools,
    [block.toolCallId]: { ...tool, argsText: tool.argsText + delta.delta },
  },
}
```

`withExecutionIdentity` (`toolIdentity.ts:167`) does the same spread for every
`tool_execution_start/update/end`.

**Cost, and when it is paid.** `state.tools` accumulates one entry per tool call
for the entire session. Once it passes V8's ~128-property threshold the object
goes to dictionary mode and `{ ...obj }` becomes markedly slower. The spread
runs **per delta** while a tool's arguments stream, and **per output update**
while a tool streams results.

Measured per-event reducer cost as a function of how many tool calls the session
has already accumulated (`src/features/chat/reducer.ts` bundled and driven
directly, 2 000 events per point after warm-up):

| prior tool calls | `toolcall_delta` | `text_delta` (control) | ratio |
| ---------------- | ---------------- | ---------------------- | ----- |
| 0                | 1.1 µs           | 0.96 µs                | 1×    |
| 100              | 0.7 µs           | 0.42 µs                | 2×    |
| 200              | **39.0 µs**      | 0.33 µs                | 119×  |
| 400              | **72.3 µs**      | 0.33 µs                | 217×  |
| 800              | **152.5 µs**     | 0.51 µs                | 297×  |
| 1600             | **288.4 µs**     | 0.85 µs                | 338×  |

The `text_delta` control stays flat because `items` is a dense array and
`replaceItem`'s `slice()` is a memcpy. Only the dictionary spread scales.

Concretely: a 500 KB `write` streams ~2 500 arg deltas. In a session that has
already made 400 tool calls that is **180 ms** of renderer main-thread time in
record copying alone; at 1 600 tool calls, **720 ms**. This is on top of F3 and
F4, which are paid on the same events.

**Fix.** Two options, in increasing order of effort:

1. Cheap and local: switch `ChatSessionState.tools` to `Map<string, ToolState>`
   and copy with `new Map(prev).set(id, next)`. MEASURED 4–9× faster than the
   object spread (40 µs → 6 µs at 200 entries; 924 µs → 172 µs at 3 200). Still
   O(n), so it buys headroom rather than fixing the shape.
2. Correct: stop routing per-token accumulation through the session-wide record.
   `argsText` is only ever read for the tool being streamed — park it on the
   `AssistantBlock` (`{ type: 'tool', index, toolCallId, argsText }`) so the
   delta touches `items` (an array, ~0.3 µs) and only writes `tools` at
   `toolcall_end` / `tool_execution_*`. Same for `tool_execution_update`'s
   `output`.

A third, orthogonal mitigation: coalesce `toolcall_delta` into one store write
per animation frame. That reduces F2, F3 and F4 together.

**Risk.** Option 1 is mechanical but touches every `state.tools[...]` read site
(reducer, `toolIdentity`, `messageContent`, `MessageList`, `ActivityGroup`,
`collectTouchedFiles`, `ToolCard`) and the shape is part of `ChatSessionState`,
which `chat.ts` spreads — a `Map` inside a spread object is fine, but the
hydration tests assert on `Object.keys(state.tools)`. Medium risk, well covered
by the existing 746 tests. Option 2 is a real refactor of the streaming
contract; `reducer.test.ts` and `toolIdentity.test.ts` are the guard rails.
Coalescing is the lowest-risk of the three but changes visible streaming
cadence, which the e2e density test may notice.

---

## F3 — The whole transcript is re-derived, and every visible row re-rendered, per token

**Severity: high · MEASURED · `src/features/chat/MessageList.tsx:53`**

```ts
const rows = useMemo(() => buildTranscriptRows(items), [items])
```

**Cost, and when it is paid.** `reduceChatEvent` returns a new `items` array on
every token (`replaceItem` → `items.slice()`), so the `useMemo` key changes on
every token and `buildTranscriptRows` walks the **entire** transcript and
allocates a fresh row object for **every** row, per token. Because every row
object is new, `MessageItemView`'s `memo` compares `Object.is(prevRow, nextRow)`
and always misses — so every row inside the virtual window re-renders on every
token, along with `ActivityGroup`, `ToolCard`, `summarizeTool`, and the
virtualizer's `measureElement` ref work.

Measured `buildTranscriptRows` alone (real module, synthetic transcripts):

| transcript items | per call    |
| ---------------- | ----------- |
| 31               | 2.3 µs      |
| 151              | 4.9 µs      |
| 601              | 19.1 µs     |
| 1501             | 47.9 µs     |
| 3001             | **98.2 µs** |

Measured end-to-end in a jsdom + react-dom 19 harness that mirrors
`MessageList`'s structure (real `buildTranscriptRows`, real reducer, a 28-row
window, **stub leaf components** — so the absolute ms is a floor, not the real
cost; the render counts and the scaling are the transferable results):

| turns | items | `MessageItemView` renders / 500 tokens | ms/token |
| ----- | ----- | -------------------------------------- | -------- |
| 10    | 21    | 10 500                                 | 0.06     |
| 100   | 201   | **14 000**                             | 0.04     |
| 500   | 1001  | **14 000**                             | 0.05     |
| 1000  | 2001  | **14 000**                             | 0.09     |

28 memo-missed component renders per token, independent of how much actually
changed. `Markdown` renders exactly 500 times in all four rows — the markdown
memoization is doing its job (see ALREADY FINE), which is why this has not been
catastrophic so far.

Same harness with rows built **incrementally** (reuse the rows derived from the
unchanged prefix of `items`, rebuild only from the first changed item, backing
the split off to the start of an enclosing activity run):

| turns | items | renders / 500 tokens | ms/token |
| ----- | ----- | -------------------- | -------- |
| 10    | 21    | 500                  | 0.05     |
| 100   | 201   | 500                  | 0.03     |
| 500   | 1001  | 500                  | **0.02** |
| 1000  | 2001  | 500                  | **0.02** |

28× fewer component renders, and per-token cost stops scaling with transcript
length (0.09 → 0.02 ms at 2 001 items).

A naive alternative — build all rows then re-stabilize identities against a
cached `Map` — was also measured and is **worse** (0.23 ms/token at 2 001
items): it fixes the render count but adds its own O(n) pass. Do not do that.

**Fix.** Make `buildTranscriptRows` incremental. Keep `{ prevItems, prevRows,
rowStartForItem[] }` on a ref; find the first index where
`items[i] !== prevItems[i]`; splice the tail. The only subtlety is that an
`activity` row can span message boundaries, so the split point must be moved
back to the first item feeding the enclosing activity run. `transcriptRows.ts`
is already pure and has its own test file, which makes this cheap to verify.

**Risk: medium.** Row grouping is load-bearing for spacing, the virtualizer's
`getItemKey`, and `activeActivityId`. Get the activity-run back-off wrong and
rows will visually re-group mid-stream. `transcriptRows.test.ts` plus the e2e
"rows are dense and sit flush" check are the guards; add a property test that
the incremental result equals `buildTranscriptRows(items)` for random edit
sequences.

---

## F4 — `summarizeTool` re-parses the whole accumulated args on every delta

**Severity: high · MEASURED · `src/features/chat/tools/toolSummaries.ts:80`**

```ts
const args = tool.args ?? tryParseArgs(tool.argsText)
```

**Cost, and when it is paid.** While a tool call streams, `tool.args` is
undefined, so `tryParseArgs` runs `JSON.parse` on the accumulated (still
truncated, therefore always-throwing) args text. V8 must scan the whole string
before it can fail. `ToolCard` is memoized on `tool`, and `tool` gets a new
identity on every delta (F2), so this runs once per delta — O(n) per delta over
a growing n, i.e. O(n²) per tool call.

Measured (200-byte deltas, real `summarizeTool`):

| streamed payload | deltas | total      | per delta |
| ---------------- | ------ | ---------- | --------- |
| 10 KB            | 51     | 0.7 ms     | 14 µs     |
| 49 KB            | 251    | 9.8 ms     | 39 µs     |
| 195 KB           | 1 001  | **109 ms** | 109 µs    |
| 488 KB           | 2 501  | **665 ms** | 266 µs    |

`artifact_create` behaves identically (649 ms at 488 KB) — `partialStringArg`
bails early, so the cost is entirely the failing `JSON.parse`.

The code's own comment at `toolSummaries.ts:83-86` says "large payloads like
`write` or `artifact_create` sit here for a while" — that is precisely the case
that is quadratic.

**Fix.** Do not attempt a parse until the payload is plausibly complete. Cheapest
correct version: remember the last-attempted length on the `ToolState` and retry
only when `argsText.length` grows past a threshold _and_ the last non-space
character is `}`. Better: while `status !== 'done'`, use `partialStringArg` for
the one or two fields the label needs (`path`, `command`, `pattern`, `title`)
and never call `JSON.parse` at all — those scans terminate at the value's
closing quote, near the start of the payload.

**Risk: low.** `summarizeTool` is pure and has `toolSummaries.test.ts`. The only
behavioural change is that a label may appear a fraction of a second later on
small payloads; the final args always arrive via `tool_execution_start` /
`toolcall_end`, which set `tool.args` and bypass the parse entirely.

---

## F5 — `shared/rpc.ts`'s `message_update` mirrors a pi that no supported version emits

**Severity: high · VERIFIED against the installed pi · `shared/rpc.ts:195-211, 227`**

Phosphor declares:

```ts
| { type: 'message_update'; message: AgentMessage; assistantMessageEvent: AssistantMessageEvent }
```

with `partial?: AssistantMessage` on every delta variant.

The installed pi is **0.84.2**, and `shared/models.ts:293` sets
`MIN_PI_VERSION = '0.84.1'`. pi's own `dist/modes/json-event.js` — the function
`rpc-mode.js:266` pipes every event through — is:

```js
const { partial: _partial, ...deltaEvent } = assistantMessageEvent
return { type: 'message_update', usage: event.message.usage, assistantMessageEvent: deltaEvent }
```

`message` is gone, `partial` is gone, and `usage` is new. pi's CHANGELOG lists
this under **0.84.0 → Breaking Changes**:

> Changed JSON and RPC `message_update` events to emit only `assistantMessageEvent`
> deltas, removing the cumulative `message` and `assistantMessageEvent.partial`
> fields **that caused quadratic output growth**.

`docs/rpc.md#message_update` documents the new shape. The drift guards at the
bottom of `shared/rpc.ts` cannot catch this — its own header says so.

**Consequences.**

1. **Every `delta.partial` read is dead code** against every supported pi:
   `reducer.ts:343` (`toolcall_start`) and `reducer.ts:370` (`toolcall_delta`)
   both call `revealedToolCall(delta.partial, …)`, which now always returns
   `null`. So tool identity is **never** revealed during streaming; every tool
   call streams under a `pending-*` placeholder and is re-keyed only at
   `toolcall_end`. The comment at `reducer.ts:366-368` claims this makes the
   card "stop reading 'Preparing tool…' while a large payload streams" — with
   pi ≥0.84.0 it never does. The placeholder path in `toolIdentity.ts` still
   works (that's why nothing is visibly broken), it is just now the _only_ path.
2. **`usage` is available free on every delta and is ignored** — see F8.
3. `event.message` on `message_update` is dead weight in the type. Nothing in
   the reducer reads it (`applyAssistantDelta` only touches
   `event.assistantMessageEvent`), so there is no runtime bug, only a lie in the
   protocol mirror.

**The good news** is that the payload duplication this audit was asked to look
for has already been fixed _upstream_. Measured on the repo's own captured
stream (`src/features/chat/__fixtures__/real-session-events.jsonl`, 228 records,
289.8 KB, one user turn with three tool calls):

|                                     | total                      | avg     | max     |
| ----------------------------------- | -------------------------- | ------- | ------- |
| fixture as captured (pre-0.84.0)    | 273.1 KB across 193 deltas | 1 449 B | 2 196 B |
| same deltas in the pi ≥0.84.0 shape | 48.3 KB                    | 256 B   | 505 B   |

**82.3 % smaller**, and `message_update` drops from **94.2 %** of the whole
stream's bytes to about 60 % of a much smaller stream. The growth signature is
visible in the fixture: the first five deltas are 1 150–1 195 B, the last five
are 1 635–1 776 B, on a _tiny_ session — that is the cumulative snapshot growing
under each delta.

**Fix.** Re-mirror `message_update` against pi 0.84.2: drop `message`, drop
`partial` from all ten delta variants, add `usage: Usage`. Then delete
`revealedToolCall` and the two call sites, and simplify `toolIdentity.ts` to the
single placeholder-adoption path it actually exercises (keep
`applyRevealedIdentity` — `toolcall_end` and `adoptPendingTool` still use it).

**Risk: low-to-medium.** Deleting the `partial` path removes support for pi
<0.84.0, which `MIN_PI_VERSION` already refuses to run. The compile-time drift
guards will not help here, so re-verify against pi's command switch by hand as
the file header instructs. Regenerate the fixture (F19) in the same change or
`reducer.replay.test.ts` will keep validating a wire format that no longer
exists.

---

## F6 — `releaseWorkspace` is never called; the retention it documents is still there

**Severity: high · VERIFIED · `src/stores/files.ts:197`**

The doc comment claims:

> Without this, browsing several projects retained every explorer listing and
> every file buffer (each held twice: `content` + `savedContent`, plus the
> Monaco model and its language-worker mirror) for the app's lifetime.

`grep -rn releaseWorkspace src/` returns exactly three call sites, all inside
`src/stores/filesRelease.test.ts`. **No production code calls it.** The test
passes, so the fix reads as landed in CI and in review; the retention it
describes is unchanged.

`closeFile` (`files.ts:170`) _is_ wired up and does release a single model, so
per-tab cleanup works. What is missing is the workspace-level release —
switching to a session in another project leaves the previous project's
`byWorkspace` slice, its `entries` explorer listings, every `OpenFile`
(`content` + `savedContent`, so 2× each file's bytes) and every Monaco model
(plus its TS/JSON/CSS/HTML worker mirror) alive until quit.

**Fix.** Call it. The natural hook is where a workspace stops being reachable:
in `disposeSession` (`src/stores/sessions.ts:433`), after removing the session
from `live`, release any `workspacePath` no remaining live session references.
`useActiveWorkspace()` derives from `live`, so "no live session in this folder
and it is not `homePath`" is a sound eviction predicate.

**Risk: low-to-medium.** Releasing too eagerly loses unsaved editor buffers.
Guard on `openFiles.every(f => !f.dirty)` or prompt, and never release the
workspace behind the currently active session. `filesRelease.test.ts` already
covers the store mechanics; what needs a new test is the eviction predicate.

---

## F7 — Live pi subprocesses are unbounded

**Severity: high · MEASURED · `src/stores/sessions.ts:433-491`, `electron/pi/session-registry.ts`**

**Cost.** One `pi --mode rpc` process per open session, forever. Measured on
this machine: an **idle** pi RPC process tree, on an empty workspace with no
transcript, is **172 MB RSS** (`ps` over the full child tree, 6 s after spawn).
The store's own comment says "~200 MB". Ten open sessions is ~1.7 GB before
Electron's own three-plus processes.

Nothing reclaims them automatically. `disposeSession` / `suspendSession` are
reachable only from the sidebar context menu, the tree-view modal, and the
session-error banner. There is no LRU, no idle timeout, no memory-pressure
response. `SessionRegistry` deliberately keeps entries after the child exits
(documented, and correct for crash-resume), so a crashed session's registry
entry and the renderer's `unsubscribers` entry also persist until an explicit
dispose.

**Fix.** Auto-suspend on a bound: keep the N most-recently-active sessions live
and `suspendSession` the rest. The machinery already exists and is cheap to
undo — `sessions.ts:80-83` measures resume at ~940 ms and `MessageList` already
renders a "the process was released to save memory" skeleton for it. N=3 with an
idle timeout (say 15 minutes with no events and not the active session) would
cover the common case.

**Risk: medium.** Suspending a session that is mid-stream would lose the tail of
a reply, so the predicate must require `!isStreaming` and no pending RPC. Make N
a setting, since a user driving four agents in parallel deliberately wants four
live processes. `suspendSession.test.ts` and `sessionCleanup.test.ts` exist as a
starting point.

---

## F8 — 28–49 `get_session_stats` round trips per user turn

**Severity: medium · MEASURED · `src/stores/sessions.ts:15-22, 219-221`**

```ts
return (
  eventType === 'agent_end' ||
  eventType === 'compaction_end' ||
  eventType === 'message_end' ||
  eventType === 'tool_execution_end'
)
```

**Cost, and when it is paid.** `message_end` fires for user, assistant **and**
`toolResult` messages, and pi emits one assistant message per tool call — so a
single tool call produces three stats refreshes (assistant `message_end`,
`tool_execution_end`, toolResult `message_end`). Each is a full round trip:
renderer → `ipcRenderer.invoke` → main → pi stdin → pi → stdout → JSONL decode →
`JSON.parse` → promise resolve → IPC reply → `setStats`.

Counted against two real session files on this machine:

| session           | bytes  | user turns | assistant msgs | toolResults | toolCalls | stats round trips | **per user turn** |
| ----------------- | ------ | ---------- | -------------- | ----------- | --------- | ----------------- | ----------------- |
| `…tars…019dca80`  | 634 KB | 9          | 86             | 80          | 80        | 255               | **~28**           |
| `…games…01a02433` | 505 KB | 4          | 64             | 64          | 64        | 196               | **~49**           |

The repo's own captured fixture (one user turn, three tools) would trigger 12.

The comment defending this is accurate as far as it goes — `get_session_stats`
is in-memory on pi's side, no I/O — but it is still a serialized IPC round trip
per sub-step, and each resolution writes the chat store.

**Fix.** pi now ships cumulative `usage` on **every** `message_update`
(F5), which is exactly what the context meter and the working indicator's token
readout consume. Fold `usage` from the delta stream into `stats.tokens` and drop
the refresh to `agent_end` / `compaction_end` only (where the authoritative
cost/message counts matter). That removes ~90 % of the round trips and makes the
meter smoother rather than steppier.

**Risk: low.** `shouldRefreshStatsOn` is exported precisely so the trigger set is
testable (`sessions.test.ts`). The one thing to preserve is that `cost` and the
message counters still come from pi, since `usage` carries tokens and cost per
message but not the session-level counts. Requires F5's type fix first.

---

## F9 — `JsonlDecoder` is quadratic when one record spans many stdout chunks

**Severity: medium · MEASURED · `electron/pi/jsonl.ts:19-31`**

```ts
this.buffer += typeof chunk === 'string' ? chunk : this.decoder.write(chunk)
while ((newlineIndex = this.buffer.indexOf('\n')) !== -1) { … }
```

**Cost, and when it is paid.** `+=` builds a `ConsString`; `indexOf` forces V8 to
flatten it, copying the whole buffer. With a pipe chunk size of 64 KB, a record
of size S arrives in S/65536 chunks and costs O(S²/65536) bytes of flattening.

Measured (single record, 64 KB chunks), against a decoder that indexes from an
offset and never concatenates the pending tail:

| record size | current      | offset-based |
| ----------- | ------------ | ------------ |
| 1.0 MB      | 4.7 ms       | 0.6 ms       |
| 1.9 MB      | 13.7 ms      | 2.7 ms       |
| 3.8 MB      | 62.3 ms      | 2.8 ms       |
| 7.6 MB      | 246.8 ms     | 8.8 ms       |
| 15.3 MB     | **958.9 ms** | **17.6 ms**  |

Clean quadratic (4× size → 16× time). The multi-record case is fine — many
short lines in one chunk decode linearly (4 000 × 500 B = 1.8 ms), because
V8's sliced-string representation makes those `slice`s cheap.

**When does pi emit a multi-MB single record?** `get_messages` (the whole
transcript on resume), `agent_end.messages` (every message of a run), and any
`tool_execution_end` with a large result. Real session files on this machine top
out at 643 KB (longest single line 307 KB), so today's cost is ~2–5 ms — not
alarming. It becomes alarming exactly when it hurts most: the biggest session,
on the resume path.

**Fix.** Track a read offset instead of re-slicing the buffer, or keep the
pending tail as an array of fragments and `join('')` only when a newline is
found. Both are ~15 lines and preserve the strict-LF / U+2028 semantics the
class exists for.

**Risk: very low.** `jsonl.test.ts` covers the framing contract, including the
multi-byte-split and U+2028 cases. Keep `end()`'s behaviour identical.

---

## F10 — `agent_end` and `turn_end` ship the whole run over IPC to be discarded

**Severity: medium · MEASURED · `electron/ipc/pi-session-handlers.ts:95`, `src/features/chat/reducer.ts:82-112`**

Every event from pi is forwarded verbatim:

```ts
session.client.on('event', (ev) => push({ kind: 'event', event: ev }))
```

The reducer then does this with two of them:

- `turn_start` / `turn_end` → `return state` (`reducer.ts:110-112`). `turn_end`
  carries `{ message, toolResults }` — every tool result of that turn.
- `agent_end` → reads only `event.willRetry`. `agent_end` carries
  `messages: AgentMessage[]` — **every message of the whole run**, including
  every tool result payload.

**Cost.** The main process pays V8 structured-clone serialization, the renderer
pays deserialization, and then the reducer throws it away. Measured (synthetic
runs shaped like real ones):

| run              | JSON size | `JSON.parse` in rpc-client | v8.serialize | v8.deserialize |
| ---------------- | --------- | -------------------------- | ------------ | -------------- |
| 10 tools × 20 KB | 0.19 MB   | 0.14 ms                    | 0.09 ms      | 0.12 ms        |
| 20 tools × 20 KB | 0.39 MB   | 0.17 ms                    | 0.18 ms      | 0.24 ms        |
| 40 tools × 49 KB | 1.92 MB   | 1.03 ms                    | 0.88 ms      | 0.73 ms        |

So ~1–2 ms and up to ~2 MB of transient allocation per agent run, on both sides,
for data nothing reads. In the repo's own fixture `agent_end` is 4 221 B and
`turn_end` totals 4 039 B — 2.8 % of that (tiny) stream, but they scale with the
run, not with the turn count.

Note the payload also crosses stdout **four times** per tool call in total:
`tool_execution_end.result`, the toolResult `message_end`, `turn_end.toolResults`,
and `agent_end.messages`. Phosphor needs the first two.

**Fix.** Slim the events in `push`, in the main process, before `contents.send`:
drop `messages` from `agent_end` (keep `willRetry`) and drop `message` /
`toolResults` from `turn_end` (or stop forwarding `turn_start`/`turn_end`
entirely). One `switch` in `pi-session-handlers.ts`.

**Risk: low**, with one caveat: this makes the renderer's `PiEvent` narrower than
pi's, so the slimming must be expressed in the type (a `ForwardedPiEvent`
mapped type) rather than left implicit, or a future feature will reach for
`agent_end.messages` and find `undefined`. Do it in the same change as F5.

---

## F11 — `message_end` folding is O(items + tools), once per tool call

**Severity: medium · MEASURED · `src/features/chat/reducer.ts:505, 526`**

```ts
tools: pruneOrphanedPendingTools(toolsFromContent(assistant, state.tools), items),
```

`pruneOrphanedPendingTools` (`toolIdentity.ts:132`) builds a `Set` of every tool
block id across **all** items before it checks whether any key is even pending;
`toolsFromContent` (`messageContent.ts:92`) copies the whole `tools` record
whenever the message introduces a new tool call. pi emits one assistant message
per tool call, so both run once per tool call ⇒ O(n²) across a session.

Measured, assistant `message_end` with one new tool call:

| turns | items | tools | per event    |
| ----- | ----- | ----- | ------------ |
| 50    | 100   | 50    | 17.5 µs      |
| 200   | 400   | 200   | 51.9 µs      |
| 500   | 1 000 | 500   | 133.3 µs     |
| 1 000 | 2 000 | 1 000 | 332.4 µs     |
| 2 000 | 4 000 | 2 000 | **616.1 µs** |

Split of the cost at 1 000 tools: the record copy is ~419 µs, the prune ~94 µs,
and an early-return prune (bail when no key is pending) is ~51 µs.

Once per tool call rather than per token, so this is a second-order problem —
but it compounds with F2 on the same sessions.

**Fix.** Early-return in `pruneOrphanedPendingTools` when no key matches
`isPendingToolId` — cheap, purely local, no behaviour change. The record copy is
inherent to the immutable store and goes away with F2's option 1 or 2.

**Risk: very low** for the early return; `toolIdentity.test.ts` covers the
pruning contract directly.

---

## F12 — `FilesChangedPane` re-derives every touched file on every tool delta

**Severity: medium · MEASURED · `src/features/files/FilesChangedPane.tsx:27-30`**

```ts
const files = useMemo(
  () => (tools ? collectTouchedFiles(tools, workspacePath) : []),
  [tools, workspacePath],
)
```

`tools` gets a new identity on every `toolcall_delta` and every
`tool_execution_update` (F2), so this `useMemo` never hits during a stream.
`collectTouchedFiles` walks every tool and calls `editDiffStats` →
`parseDisplayDiff` / `unifiedPatchStats`, re-parsing every completed edit's full
diff text each time.

Measured (patch re-parse only, the dominant term):

| session shape               | per recompute |
| --------------------------- | ------------- |
| 10 edits × 200 diff lines   | 103 µs        |
| 40 edits × 200 diff lines   | 208 µs        |
| 40 edits × 1 000 diff lines | **972 µs**    |

Paid only while the Changes pane is the selected right pane — which is exactly
when the user is watching the agent edit. A 500 KB `write` (~2 500 deltas) in a
session with 40 prior edits costs 0.5–2.4 s of extra renderer work.

**Fix.** Memoize per tool: cache `TouchedFile` contributions keyed by
`toolCallId` and rebuild only for tools whose `ToolState` identity changed.
Alternatively key the `useMemo` on something that only changes when a tool
_settles_ (e.g. a counter bumped on `tool_execution_end` / `message_end`), since
`collectTouchedFiles` already skips anything with `status !== 'done'` — a
streaming tool contributes nothing to its output, so recomputing on its deltas
is pure waste.

**Risk: low.** The `status !== 'done'` filter makes the "only recompute on
settle" reformulation provably equivalent. `collectTouchedFiles.test.ts` exists.

---

## F13 — Artifact versions grow unbounded, and are retained twice

**Severity: medium · REASONED · `src/stores/artifacts.ts:109, 122`**

Every `artifact_create` / `artifact_update` pushes a full-content
`ArtifactVersion` onto `versions[]`. There is no cap and no eviction. A model
iterating twenty times on a 100 KB HTML artifact retains 2 MB in
`artifacts.bySession`, for the session's lifetime.

The same content is retained a second time in the chat store: the tool's
`ToolState.result.details.content` (`reducer.ts:460`) holds the payload the
artifact was ingested from. So the steady-state cost is roughly 2× the sum of
all artifact versions ever produced.

`remove(sessionId)` correctly clears all four session-keyed records
(`artifacts.ts:194-205`) — that claim in the comment **is true**, verified by
reading and by `artifacts.test.ts`. But it only runs on explicit dispose (F7).

**Fix.** Cap `versions` (keep, say, the newest 10 plus v1) and drop the content
of evicted versions while keeping their metadata so the version picker still
lists them. For the double retention, have `ArtifactDetail`/`ArtifactsPane` read
content from the artifacts store and null out `details.content` on the
`ToolState` once ingested.

**Risk: low** for the cap (it is a viewer affordance, not a source of truth —
the content also lives in pi's session file). Medium for the de-duplication:
`ArtifactDetail.tsx` and `toolSummaries.ts` both read `toolDetails<ArtifactToolDetails>()`,
and history replay (`ingestFromHistory`) must keep working on resume.

---

## F14 — `git:info` is uncached and spawns four processes per call

**Severity: medium · MEASURED · `electron/ipc/git-handlers.ts:24`, `src/features/worktrees/BranchControl.tsx:36-48`**

`gitInfo()` runs `rev-parse --abbrev-ref HEAD`, `rev-parse --absolute-git-dir
--git-common-dir`, `status --porcelain`, and `rev-list --left-right --count
@{upstream}...HEAD` — four `execFile` spawns, with **no cache**. Its sibling
`gitInfoBatch` has a 5 s TTL and in-flight dedupe; `gitInfo` has neither.

`BranchControl` is mounted in the top bar for the whole session and calls it on
every `fs:changed` push, debounced 500 ms. While the agent edits files, the
workspace watcher fires continuously (250 ms debounce of its own), so this
settles at roughly two `gitInfo()` calls per second — **eight git subprocesses
per second**.

Measured on this repo: **18 ms median** (min 11, max 19) for one `gitInfo()`.
On a large repo `git status --porcelain` alone routinely exceeds 100 ms.

**Fix.** Give `gitInfo` the same TTL + in-flight dedupe `gitInfoBatch` already
has (they can share one cache keyed by cwd, with separate entries for the
"summary" and "full" variants). A 2 s TTL would collapse the steady-state to one
call per two seconds without any visible staleness.

**Risk: very low.** A cache hit can only return a value up to TTL old; the chip
already re-polls on window focus for the cases Phosphor cannot observe.

---

## F15 — Push channels broadcast to every window

**Severity: medium · REASONED**

`pty:data:<id>` (`pty-manager.ts:189-193`), `fs:changed`
(`workspace-watcher.ts:111-115`), `sessions:changed` (`session-watcher.ts:26-30`)
and `resources:sample` (`monitor.ts:34-36`) all loop
`BrowserWindow.getAllWindows()`. When the floating monitor window is open it
receives — and structured-clones — every PTY data chunk and every filesystem
change batch, despite subscribing to none of them.

`pi:createSession` is the exception and gets this right: it captures
`event.sender` and pushes only there (`pi-session-handlers.ts:89-92`).

**Fix.** Track which `WebContents` subscribed to which channel (the preload's
`subscribe()` helper is now the single choke point, so an `ipcRenderer.send`
handshake there is cheap), or at minimum tag the monitor window and skip it for
`pty:*` and `fs:*`.

**Risk: low**, but it is a small protocol addition rather than a one-liner. The
narrow version — skip the monitor window for `pty:data` — is a one-liner and
captures most of the benefit, since PTY chunks are by far the highest-rate
channel.

---

## F16 — A renderer reload orphans every live pi

**Severity: medium · VERIFIED · `electron/ipc/pi-session-handlers.ts:126`**

`SessionRegistry` lives in the main process and survives a renderer reload
(HMR in `npm run dev`, `location.reload()`, a renderer crash). The renderer's
`live` map does not. After a reload, every previously-spawned pi is still
running — 172 MB each (F7) — with no renderer that knows its id, no push
listener, and no path to `pi:disposeSession`.

`pi:listLiveSessions` exists in `shared/ipc.ts:92` and is registered in
`pi-session-handlers.ts:126` specifically to make reattachment possible. It has
**zero renderer callers**. It is dead IPC surface that also happens to be the
fix for a real leak.

**Fix.** On renderer boot, call `pi:listLiveSessions` and either reattach
(re-register push handlers, re-hydrate via `get_messages`) or dispose the
orphans. Disposing is the two-line version and stops the leak immediately;
reattaching is the better product behaviour.

**Risk: low** for the dispose-on-boot version, with one caveat: it must not run
in a second window (the monitor float loads the same bundle with
`?view=monitor`), or opening the monitor would kill every session. Gate on the
main view.

---

## F17 — The session-scanner meta cache never evicts

**Severity: low · REASONED · `electron/pi/session-scanner.ts:28`**

```ts
const metaCache = new Map<string, CacheEntry>()
```

Keyed by absolute path, invalidated by mtime+size, never removed. Entries for
deleted session files persist for the process lifetime. `usageSummary()` walks
**every** directory under pi's sessions root, so one visit to the Usage view
populates the cache with one entry per session file ever created.

Sizing on this machine: 65 files across 21 directories, ~400 B per entry ⇒
negligible. A heavy user with 5 000 sessions would hold a few MB. This is a
real unbounded structure but not a practical problem today.

**Fix.** Cap it (LRU, a few thousand entries) or prune entries whose path was
absent from the last `readdir` of their directory.

**Risk: very low.** `session-scanner.test.ts` covers the cache semantics.

---

## F18 — `ArtifactsPane` writes to the store on every render

**Severity: low · REASONED · `src/features/artifacts/ArtifactsPane.tsx:33-35`**

```ts
useEffect(() => {
  if (activeSessionId) useArtifactsStore.getState().clearUnseen(activeSessionId)
})
```

No dependency array, and `clearUnseen` unconditionally builds a new `unseen`
object even when the count is already 0. Every render of the pane therefore
publishes a new store state, re-running every `useArtifactsStore` selector in
the app. It does not self-loop (this component subscribes to `bySession`,
`selected`, `selectedVersion` — not `unseen`), so it is waste rather than a bug.

**Fix.** `useEffect(…, [activeSessionId])`, and make `clearUnseen` return the
same state when the count is already 0 (the pattern `doneResuming` in
`chat.ts:168` already uses).

**Risk: very low.**

---

## F19 — The captured event fixture uses a wire format pi no longer emits

**Severity: low · MEASURED · `src/features/chat/__fixtures__/real-session-events.jsonl`**

All 193 `message_update` records in the fixture carry `message` and
`assistantMessageEvent.partial`, and **none** carry `usage` — i.e. it was
captured against pi <0.84.0. Those removed fields are **94.2 %** of the
fixture's total bytes.

`reducer.replay.test.ts` is the only test that exercises a real stream, so it
is validating the reducer against a protocol no supported pi speaks. That is why
F5 went unnoticed: nothing in CI sees the current shape. The e2e stub is the
same story — `e2e/fixtures/pi-stub.cjs:570-601` emits
`message: { role: 'assistant', content: [] }` on `message_update`.

**Fix.** Re-capture the fixture against pi 0.84.2 and drop `message` from the
stub's `message_update` emissions, as part of F5.

**Risk: low**, but expect `reducer.replay.test.ts` assertions about tool
identity to need adjusting — under the new shape identity genuinely is not known
until `toolcall_end`, so the placeholder-adoption path is the one under test.

---

## ALREADY FINE — checked, no action needed

Listed so nobody re-derives these.

**Markdown / syntax highlighting is properly memoized.** `Markdown`
(`src/components/markdown/Markdown.tsx:153`) is `memo`'d on `text` + `streaming`,
with module-level `REMARK_PLUGINS` / `REHYPE_PLUGINS` / `components` constants,
so a re-render with unchanged text does not re-run remark/rehype/katex.
MEASURED in the React harness: 500 `Markdown` renders for 500 tokens across a
2 001-item transcript — only the one streaming block re-parses, which is
inherent to streaming markdown. `CodeBlock` skips `highlightCode` entirely while
`streaming` and cancels stale highlight requests by generation counter.

**`hydrateFromMessages` is linear.** The O(n²) → O(n) claim
(`reducer.ts:598-607`) holds; `hydrationScale.test.ts` guards it with a scaling
assertion and an 8 k-turn budget, and both pass.

**`result` and `output` share one payload object.** The `reducer.ts:442-451`
claim about 293 KB retained as 585 KB is **true and still true**, in both the
hydration path (`toolStateForResult`, `reducer.ts:460`) and the live path
(`tool_execution_end`, `reducer.ts:184-186`, which assigns `event.result` to
both fields). `hydrationScale.test.ts` asserts `tool.result === tool.output`.
The live path additionally _replaces_ the `tool_execution_end` payload with the
`message_end` toolResult payload rather than keeping both — so there is no
double retention there either.

**`artifacts.remove` cleans all four session-keyed records.** `bySession`,
`selected`, `selectedVersion`, `unseen` — the comment at `artifacts.ts:192-193`
is accurate, and `artifacts.test.ts` covers it.

**The resource monitor is genuinely off when nobody is watching.** Reference
counted on both sides (`electron/resources/monitor.ts`,
`src/features/resources/resourcesStore.ts`), 2 s tick, one `ps -Ao` per tick for
the whole machine rather than one spawn per session, `inFlight` guard so a slow
`ps` cannot build a backlog, timer `unref`'d. Renderer history is a bounded ring
(`HISTORY_LIMIT = 60`), rebuilt from the new snapshot each tick so disposed
sessions drop out, and cleared entirely when the last viewer detaches.

**PTY status polling is gated and unref'd.** `syncPolling`
(`pty-manager.ts:156-186`) starts only when a PTY exists, stops at zero, and
broadcasts only on change.

**The session scanner's mtime+size cache works.** MEASURED on a real workspace:
cold `listSessions` 19 ms for 7 files, warm 0.9 ms. A `sessions:changed` push
re-parses only the file that actually changed — MEASURED 4.0 ms for the largest
real session here (643 KB). Combined with `awaitWriteFinish` (250 ms) plus a
300 ms notify debounce, the streaming steady state costs a few ms/s of main
process. Fine.

**Workspace watching is bounded — on four axes, not two.** `IGNORED_DIRS` +
`MAX_WATCH_DEPTH = 3` bound the DIRECTORY walk; `MAX_DIR_ENTRIES = 2 000` and
`MAX_WATCHED_PATHS = 12 000` bound the fd count (`workspace-watcher.ts`), with
measured justification in the comments, plus 250 ms batching. Session-dir
watchers are tied to sidebar group expansion and closed on quit.

The two fd bounds were added 2026-08-31, after the first two proved not to be
bounds at all: chokidar opens one fd per watched PATH, files included, and the
depth cap is blind to a flat directory because every file in it sits at the
same legal depth. See
[docs/log/2026-08-31-workspace-watcher-fd-budget.md](../../log/2026-08-31-workspace-watcher-fd-budget.md).
The `error` handler does NOT make EMFILE survivable, and this doc previously
claimed it did: by the time chokidar reports EMFILE the fds are already gone,
and the failure lands on whatever opens a file next — in practice
`electron-store` reading `config.json`, i.e. session start.

**`gitInfoBatch` is cached.** 5 s TTL, in-flight dedupe, concurrency capped at
4, skips the extra `rev-list`. (Its uncached sibling is F14.)

**The reducer's text path is flat.** MEASURED: `text_delta` costs 0.33–0.96 µs
per event regardless of transcript length (0 → 1 600 prior tool calls). The
`items` array copy in `replaceItem` is a dense memcpy and is not a problem.

**`AssistantText`'s `fullText` join and `summarizeActivity` are free.** MEASURED
0.05–0.09 µs per row per token for the join (all message sizes), and 0.76 µs per
render for `summarizeActivity` + `isActivityLive` on an 18-step group. These
looked like per-token O(message) work and are not worth touching.

**zustand selectors are leaf-level.** Every `useChatStore` call site selects a
scalar or one sub-object, so `setStats` / `setMeta` do not cause a broad
re-render despite replacing the session object. `workspaceFiles()` /
`sessionTerminals()` return shared frozen empty values as documented.

**`message_update` is small on the wire now.** MEASURED 285 B for a realistic
delta in pi's current shape; `structuredClone` of one is below timer resolution.
The IPC cost per token is not where the money is — it is all renderer-side
(F2/F3/F4).

**`unsubscribers` in `src/stores/sessions.ts:90`** is added in `createSession`
and deleted in `disposeSession`; there is no path that registers twice for one
id. It only outlives its session in the same circumstances as F7/F16 (a session
that is never disposed), so it is not an independent leak.

**Session-scoped cleanup on dispose is thorough.** `disposeSession`
(`sessions.ts:433`) awaits terminal kill, artifacts, layout, and extension-UI
cleanup and removes `live` / `unread` / `baselines`. The comments claiming
`baselines` and `clearSession` were previously missed are accurate — both are
wired now.

---

## Method / reproducing

Benchmarks were built with the repo's own esbuild against the real modules
(`src/features/chat/reducer.ts`, `items/transcriptRows.ts`,
`tools/toolSummaries.ts`, `electron/pi/jsonl.ts`,
`electron/pi/session-scanner.ts`) and run under node v22.22.0 outside the repo.
The React measurements used a jsdom + react-dom 19 harness mirroring
`MessageList`'s memo structure with stub leaf components — its absolute
milliseconds are a floor, and only the render counts and the scaling curves
should be quoted. Real-world counts (F8, F19) come from session files under
`~/.pi/agent/sessions` and from the repo's own captured fixture. Protocol claims
(F5) were checked against the installed
`@earendil-works/pi-coding-agent@0.84.2` — `dist/modes/json-event.js`,
`dist/modes/rpc/rpc-mode.js`, `docs/rpc.md`, and `CHANGELOG.md`.
