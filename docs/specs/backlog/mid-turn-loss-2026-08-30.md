# Mid-turn loss: an app exit discards the whole in-flight turn

Traced from one report — session `01a052f4` "did not answer". It did answer.
The reply was never written, because the app exited while the turn was still
running and **pi persists a turn only when the turn ends**.

This is not an updater bug and not a provider bug. The updater is the trigger
that fired this time; the defect is that every exit path drops in-flight work
with no warning before and no trace after.

## What happened, from the logs

| Time (UTC) | Layer           | Event                                                                             |
| ---------- | --------------- | --------------------------------------------------------------------------------- |
| 15:20:06   | pi session file | user message `fix conflicts …/pull/124` written, turn starts                      |
| 15:20:18   | provider        | rebases onto main, force-pushes, PR back to MERGEABLE                             |
| 15:21:03   | provider        | starts polling CI in a blocking `until … sleep 20 … done` loop, `timeout: 600000` |
| 15:22:43   | Phosphor        | `[updates] staged macOS update {"version":"0.1.139"}`                             |
| 15:28:18   | provider        | last record — an assistant `tool_use`, `stop_reason: tool_use`                    |
| 15:28:32   | Phosphor        | `[app] session start` — the app process restarted                                 |
| 15:28:43   | Phosphor        | `[updates] installing macOS update`                                               |
| 15:28:46   | Phosphor        | `[app] session start {"version":"0.1.139"}`                                       |
| 15:29:27   | Phosphor        | pi respawned with `--session <file>`, resuming from the last persisted state      |

The turn was in flight for **8m 12s** when the app went away.

### The three facts that make it conclusive

1. **The turn never ended.** The provider transcript
   (`~/.claude/projects/…/ee516e7b-….jsonl`) has **183 lines and zero
   `type: "result"` records**. Its final record is an assistant `tool_use` with
   `stop_reason: tool_use`. A completed turn always writes a `result`.
2. **The pi session file is intact, not truncated.** 11 lines, 16125 bytes,
   ends with a newline, last record is the user message. Nothing was corrupted
   mid-write; nothing was ever offered to be written.
3. **pi did not crash.** There is no `[pi] exited unexpectedly` in the debug
   log for this session. The app quit deliberately and SIGTERMed its children.

An earlier read of this incident called it "IPC loss / a closed stdio pipe".
That was wrong — there was no IPC failure. The pipe closed because the parent
process exited on purpose.

## Why the loss is total

`electron/main.ts` `before-quit` calls `registry.disposeAll()`, and
`electron/pi/rpc-client.ts:210` `dispose(graceMs = 3000)` sends `SIGTERM`, then
`SIGKILL` 3s later. Its neighbouring comment in `main.ts` says pi "gets a
SIGTERM to flush" — **that assumption only holds between turns.** pi writes a
session's file at turn end, so a turn interrupted at 8 minutes has nothing to
flush and 3 seconds would not be enough regardless.

The result the user sees is a session whose transcript stops at their own
message. No error, no partial reply, no marker. It reads as "the model ignored
me", which is why the first diagnosis went looking at the provider.

## Findings

| #   | Finding                                                                                                                                                                                                                      | Status |
| --- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------ |
| M1  | `updates:restartAndInstall` runs with zero checks on session state. `electron/ipc/updates-handlers.ts:16` → `updater.ts:366` → `app.quit()`. Both UI entry points (`UpdatePill.tsx:40`, `AboutTab.tsx:74`) call it directly. | Open   |
| M2  | `before-quit` (`electron/main.ts:164`) has no in-flight check either, so Cmd+Q and window-close lose turns the same way.                                                                                                     | Open   |
| M3  | The user gets no warning before the quit and no marker after it. The session is indistinguishable from one the model never answered.                                                                                         | Open   |
| M4  | `main.ts`'s "pi owns its session files and gets a SIGTERM to flush" comment is wrong for an in-flight turn and actively misleads.                                                                                            | Open   |
| M5  | Contributing factor, not a Phosphor defect: the model held the turn open ~8 min in a blocking `until … sleep 20 … done` CI poll. Long polls inside a turn widen the loss window by orders of magnitude.                      | Open   |

## The signal to guard on already exists

`FleetHub` is started unconditionally for every session at
`electron/ipc/pi-session-handlers.ts:218` — not orchestrator-only. Its
`FleetPhase` (`shared/models.ts:414`) is
`'streaming' | 'awaiting-input' | 'idle' | 'error' | 'exited'`, and
`fleetReducer.ts` sets `streaming` on `agent_start` and `tool_execution_start`
from pi's own event stream. It is a mechanical projection with no model in the
loop.

So "is any session mid-turn?" is already answerable in main today:

```ts
fleetHub.snapshot().sessions.filter((s) => s.phase === 'streaming')
```

No new tracking is needed. The defect is that nothing consults it before
quitting.

## Implementation plan

Three lanes, smallest first. Lane 1 fixes the incident that was reported;
lanes 2 and 3 close the rest of the hole.

### Lane 1 — refuse the update restart while a turn is live

The narrow fix for the reported failure.

1. `electron/orchestrator/fleet.ts` — add `busySessions(): FleetSession[]`
   returning `phase === 'streaming'`. One method, keeps the filter in one
   place so lanes 2 and 3 reuse it.
2. `shared/ipc.ts` — widen `updates:restartAndInstall` from `result: void` to
   `result: { ok: true } | { ok: false; busy: { sessionId: string; title?: string }[] }`.
   Compile-time, so every caller is forced to handle the refusal.
3. `electron/ipc/updates-handlers.ts` — consult `busySessions()` first. Return
   the refusal instead of calling `restartAndInstall()`. Add a `force` arg for
   the confirmed path.
4. `src/features/updates/updatesStore.ts` — put the confirm in the **store**,
   not the two components, so neither entry point can skip it.
5. New confirm modal via `ModalOverlay` (`src/components/Modal.tsx`, per the
   repo convention — not `dialog.showMessageBox`, which main does not use
   anywhere today). Lists the busy sessions by title. "Restart anyway" /
   "Wait".
6. `src/dev/mockPhosphor.ts` — add the new result shape so the browser harness
   still exercises it.

Tests: `updates-handlers` refuses when a session is streaming and passes when
all are idle; `fleet.busySessions()` unit test. Both are pure logic, no DOM.

### Lane 2 — guard every quit path

`before-quit` in `electron/main.ts` is the one choke point all exits route
through. When `busySessions()` is non-empty and the quit was not already
confirmed, `preventDefault()` and ask the focused window to show the same
modal. Keep the existing `quitting` latch so the confirmed second pass runs
straight through.

Watch two things: `hardShutdown()` (signal-initiated, must stay synchronous
and unguarded) and E2E, which quits the app between specs — gate the prompt
behind `!process.env.PHOSPHOR_TEST_USER_DATA` or have the harness confirm.

### Lane 3 — leave a trace when a turn is lost anyway

A crash, a force-quit, or a confirmed "restart anyway" will still drop a turn.
Today that is invisible. After `disposeAll()` resolves, no pi process owns the
file, which is exactly the precondition
`electron/pi/session-writer.ts` documents — so Phosphor can append a marker record
noting the turn was interrupted, and the transcript can render it.

This one is the riskiest of the three: it writes to pi's on-disk format and
depends on that format staying stable. It should land on its own, behind its
own tests, and only after lanes 1 and 2.

### Not in scope

M5 is provider-side behaviour. The durable fix is guidance to background long
polls rather than blocking a turn on them, which belongs in the session prompt,
not in this code. Worth noting in the lane prompt; not worth a Phosphor change.
