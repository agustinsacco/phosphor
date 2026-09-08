# Clone forks the Claude CLI ledger instead of orphaning it

_2026-09-07_

Follow-up to the audit in
[2026-09-07-clone-orphans-the-cli-session.md](2026-09-07-clone-orphans-the-cli-session.md)
(landing separately in [PR #218](https://github.com/agustinsacco/pidex/pull/218)):
pi's `clone` RPC branches a session onto a new file with a new pi session id,
and `@saccolabs/pi-claude-cli` keys its one-CLI-session-per-pi-session map on
that id. A cloned Claude session therefore missed the map on its first turn
and the provider reimported the entire conversation into a fresh CLI session —
a full-context cache write (64,108 tokens on the audited lane) and a discarded
cached prefix.

The fix is `electron/pi/claude-ledger-fork.ts`, called from `cloneSession`
over a new `sessions:forkClaudeLedger` channel with the clone's session file.
It does on disk what `claude --fork-session` does:

- copy `~/.claude/projects/<dir>/<oldCliId>.jsonl` under a fresh UUID,
  rewriting each line's `sessionId`
- carry the provider's stored system prompt
  (`~/.pi/agent/pi-claude-cli/sysprompt/<id>.txt`) to the new id — that file
  is what gets replayed verbatim on every resume, so losing it costs cache
  stability
- add `newPiId → newCliId` to the provider's `session-map.json`

**Why not point the clone at the same CLI session:** the original survives a
clone, and two pi sessions resuming one CLI session id would append both
conversations into a single transcript and leak turns across.

**Ownership and races:** the map is the provider's file and a parked CLI
process can write it concurrently. This module only ever ADDS a key for a pi
session id the provider has never seen, re-checks the map just before writing,
and treats losing any race as "leave no entry" — which degrades to exactly
today's behaviour, a reimport. `claude-session-map.ts` stays read-only.

**Known gap:** the original's `<cliSessionId>/` sidecar directory (oversized
tool results) is not copied, the same trade `--fork-session` makes. And the
right long-term home for this is upstream — the provider following pi's
`parentSession` lineage on a map miss — which needs pi to hand providers the
parent session id; this is the pidex-side fix that works today.
