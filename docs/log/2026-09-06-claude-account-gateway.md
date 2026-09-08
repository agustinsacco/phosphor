# Settings → Claude Code becomes a gateway — 2026-09-06

The tab had one **Usage** panel. On an install with several Claude logins it
described whichever account routing called primary, so the numbers on screen
belonged to a plan the user was very often not spending — and there was no way
to see the other accounts at all, or to find out which sessions were eating
which quota.

## Usage is per credential, so it renders per account

The panel is gone. Each account row is now a disclosure: opening it runs that
account's own `claude -p /usage` (zero quota, ~2 s, cached ~60 s in main) and
shows its windows, its bars, and its "what's contributing" block. The fetch is
deliberately on expand rather than on tab open — one CLI spawn per login, for
numbers nobody asked to see, is not a page load.

## Which lanes are spending it

`claude:accountSessions` answers "who is on this account right now": account id
→ live Phosphor session ids, read from the picks parked at spawn
(`electron/pi/session-accounts.ts`). It is the only place that can answer it —
`ClaudeAccountPrefs.bindings` is keyed by session FILE, so it knows what a
resume would bill, not what is running. Only ids cross the wire; the renderer
already holds the titles, folders and file paths.

The row header carries the count ("2 live sessions"), and the open panel lists
them by title.

## A spent account, and the two ways out

A running lane cannot change account in place: the credential is fixed by the
environment pi was spawned with, and pi-claude-cli >= 0.7.0 parks one CLI
process for the lane's whole life ([routing](2026-09-06-claude-account-routing.md)).
So both new actions are the same operation — write the binding, dispose the pi
subprocess, resume the same session file:

- **Restart** re-primes the lane on the account it is already on.
- **Move to `<account>`** sends it to another login.

`moveSessionToAccount` in `src/stores/sessions.ts` owns the order, and the
order is the whole correctness argument: the binding is written **first**,
because `pi:createSession` reads it while spawning. A failed write aborts
before the dispose, so a lane is never thrown away for a move that could not
happen. A lane with no session file yet is refused outright — pi writes the
file when the first turn ends, and there is nothing to resume before then.

The same move is offered where the problem is actually noticed: the context
popover already said "new sessions go to `<other>`" when the lane's account was
held, and now offers to send this one there too.

It is not free. The new CLI process re-reads the whole thread on its next turn,
so the cost is one full context read, and every surface that offers the move
says so.

## Not changed

Routing modes, cooldowns, the overage hold, and the `/usage` parser are as they
were. `claude:assignSession` writes a binding and nothing else — main never
touches a subprocess on the renderer's behalf here, because the dispose and the
resume are the renderer's own session lifecycle.
