# Which account a lane spends, and switching before overage — 2026-09-06

Two defects in the multi-account Claude setup, both visible in one screenshot:
a session showing "5-hour limit · limit reached" that kept working, with a
plan-usage panel whose numbers nobody could attribute to an account.

## The popover was reading the wrong account

`PlanUsage` invoked `claude:usageSnapshot` with no account id. Main then ran
`claude -p /usage` with no credential env, which reads the CLI's **default**
keychain entry — not the account the lane was spawned onto. On a single-account
install the two coincide, which is why this survived; with several accounts the
panel could report a healthy plan while the lane exhausted a different one.

The account a lane bills was already decided at spawn
(`electron/claude/routing.ts`) and parked in `session-accounts.ts`, but
`claude:bindSession` **consumed** that entry, so nothing could answer the
question afterwards. It is now a peek (`spawnAccountFor`), cleared when the
subprocess goes away, and `claude:sessionAccount` resolves it — falling back to
the persisted `bindings[sessionPath]` for a resumed lane. The popover asks for
that account's usage and names it in the section header once more than one
account is configured.

## Overage kept a spent account in rotation

`cooldownFromUsage` marks an account exhausted at 100% of its 5-hour window,
but it is fed by polling `/usage` at spawn time. It never sees the state that
actually matters here: **allowance gone, requests still served, every token
billed as pay-as-you-go credit**. That is what "limit reached but it kept
working" was. Round-robin kept handing out the one account that costs money per
token while an account with allowance sat idle.

The Claude provider already reports it. `claude-rate-limit` carries
`isUsingOverage`, `status` and `utilization`, once per change, for free
(`shared/claude-limits.ts` parses the routing half; the renderer keeps its own
display parser). Main now listens to that status on the session's own stream
and holds the account (`holdAccount`) until the reported reset, so the next
lane routes elsewhere. Three states hold an account: rejected, at or past its
window, or spending overage.

**A running lane cannot move.** Its credential is fixed by the environment pi
was spawned with, and pi-claude-cli >= 0.7.0 parks one CLI process for the
session's life. So the honest thing to show is where the _next_ lane goes,
which is what the popover now says under the usage bars.

## Not changed

Routing modes, the cooldown store, `/usage` polling and the settings tab are as
they were. `specific` still ignores cooldowns — a pinned account is a
deliberate instruction, and the popover says so rather than silently routing
around it. No provider package change: `@saccolabs/pi-claude-cli` 0.7.0 already
emits everything this needed.
