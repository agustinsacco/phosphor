# The orchestrator gets controls, an identity, and a way out

Date: 2026-08-27

Started as "why does clicking the orchestrator icon spawn a session in the
sidebar, and why can't I reset it?". Four separate faults, three of them
pre-existing bugs rather than missing features.

## 1. The orchestrator rendered as a permanent session row

Clicking the orchestrator added a row to the sidebar that never went away.

Three places filter orchestrator threads out of the session list
(`session-scanner.ts`, `groupSessionsByProject`, and the `isOrchestratorSession`
predicate they share). A fourth path was missed: `pendingSessionsByGroup`, which
draws a placeholder for a live session whose file has not appeared on disk yet.

The gate that retires a placeholder is "its path is now in the disk scan" — and
`session-scanner.ts` **deliberately keeps orchestrator paths out of that scan**.
So for an orchestrator the gate could never fire. Not a race, not a slow first
turn: a permanent placeholder, for the whole life of the process, styled as
work still starting up.

Fixed by passing the live orchestrator ids in. Matched by **session id**, not
path, because the row appears the instant the session is adopted — long before
any path is known.

## 2. The Orchestration settings tab crashed the app

Opening Settings → Orchestration rendered a blank window. On `main`, before any
of this work — verified by reverting the file and reproducing it.

`prefsFor` builds a fresh object on every call, and the tab used it as a zustand
selector. `useSyncExternalStore` therefore got a new reference on every sample,
warned that the snapshot was not cached, and then tore the app down with
"Maximum update depth exceeded". Fixed by selecting the stored prefs (a stable
reference) and merging defaults in a `useMemo`.

This is a good part of why the orchestrator felt unmanageable: its settings
screen could not be opened at all.

## 3. Recovery existed but was unreachable

`reset` and `restart` shipped in v0.1.95 — behind a right-click on a 20px icon
in the sidebar. The orchestrator's own chat had **no controls whatsoever**; its
banner was static text. So a thread that had bricked itself showed several
identical fatal errors on screen and offered nothing to click.

The banner now carries mode, cost, **Brief me**, and a menu with review, rules
and settings, restart and reset. The mode picker moved here from the composer,
where it sat beside model and thinking level and read as a per-message setting —
it is neither: it is per-project, persisted, and governs what this thread may do
to _other_ sessions.

When the thread is genuinely stuck, a **stuck bar** appears under the banner
naming the cause and offering the reset. `threadHealth.ts` decides, and is
deliberately narrow — it requires both a tool-name field _and_ a
pattern-constraint failure, so a network blip never suggests throwing away a
working conversation.

## 4. The orchestrator had no model of its own

`prefs.model` existed and `ensure()` honoured it, but **no UI ever set it**. So
every orchestrator silently inherited pi's global default — including MiniMax
M2, the model this spec already names as the one that leaks raw tool-call syntax
into the tool-name field and bricks the thread. The thread whose entire job is
calling tools was running on the model worst at calling tools, by accident.

There is now a model picker in Orchestration settings, and a warning when the
effective model is a known offender. A denylist, not an allowlist: it names only
what has actually been observed breaking.

## The icon

`✳` was doing double duty. It is the "pi is working" mark — `PiSpark` exists
because that glyph was too static for it, and the activity rows still use it —
so the orchestrator's _identity_ and every session's _busy state_ were the same
character, and the header button swapped between the two renderings of it.

`OrchestratorIcon` is a hub with three satellites: one node coordinating others.
The digest headline on home takes it too, since that is orchestrator output.
`✳` stays as Phosphor's own mark in the home greeting.

## A fixture gap this surfaced

The e2e assertion for #1 failed at first — and correctly. The pi stub honoured
`-n` when answering `get_state` but never wrote the name into the session file,
where real pi records it as a `session_info` entry and where Phosphor's sidebar
reads names from.

Under the stub, therefore, no session had a name on disk, so
`isOrchestratorSession`'s name sentinel — the durable half of that predicate,
the half that survives a prefs reset — could never fire, and an orchestrator
sorted into the sidebar as an ordinary session. The stub now writes the entry.

## Verification

`npm run validate`: typecheck, lint, format and all 29 e2e pass. Unit is green
except `git-worktrees.test.ts > renameBranch (real git)`, which fails
identically on a clean tree (confirmed by stashing) and is unrelated.

New tests: three in `groupSessions.test.ts` pinning that an orchestrator never
draws a placeholder before _or_ after its path is known, while work sessions
beside it still do; seven in `threadHealth.test.ts` over the real bricked-thread
error, including the transient failures that must **not** offer a reset. The e2e
test now asserts the banner's controls and that opening an orchestrator adds no
session row.

UI checked in the browser harness, which mocks the whole surface: banner,
stuck bar, both menus, and the model warning.
