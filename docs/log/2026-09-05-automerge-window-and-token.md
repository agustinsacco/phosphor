# 2026-09-05 — automerge was never running: no secret, and now a daytime poll

> **Removed 2026-09-05.** Automerge no longer exists — the workflow, the
> script and its tests were deleted. See
> [2026-09-05-remove-automerge.md](2026-09-05-remove-automerge.md). This entry
> is history only.

Automerge had run four times and failed all four, each in under fifteen seconds
([run 33935905176](https://github.com/agustinsacco/Phosphor/actions/runs/33935905176)).
The queue consequence was visible from the sidebar: two quiet, green PRs open
with nothing happening to them.

## The cause was setup, not logic

```console
$ gh api repos/agustinsacco/Phosphor/actions/secrets
{"total_count":0,"secrets":[]}
```

`AUTOMERGE_TOKEN` did not exist — the repository had no secrets at all. Every
run therefore died at the token check, before reading a single PR, which is the
"fail loudly rather than half-work" branch doing exactly what it was written to
do. PR #173 shipped the workflow without the one secret it needs; nothing in
CI can notice a missing secret, so the failure only showed up as red Xes on
main. The fix is an operator action, not a diff — see the box at the end.

## A 15-minute poll, 10:00–22:00 only

The trigger added in #173 is purely event-driven: CI finishing makes a PR
eligible, and CI finishing on main re-evaluates the rest. That drains a queue
nicely while someone is pushing, and does nothing at all once the repo goes
quiet — a PR that went green at the end of the day waits for the next push,
whenever that happens to be. So `schedule` is back, every 15 minutes, and both
triggers are held to 10:00–22:00 `America/Toronto` so nothing merges overnight.

**The window is enforced in `automerge-prs.mjs`, not in the cron.** Cron is
evaluated in UTC and cannot express "10am Toronto" across a DST change, and the
CI-completion trigger fires around the clock regardless of any schedule. So the
cron line is a deliberately over-wide UTC band (`*/15 14-23,0-2 * * *`) whose
only job is to keep the dead-of-night hours empty, and `isWithinWindow` applies
the real rule against wall-clock time in `TZ` — `Intl` handles the shift, which
is why the boundary test asserts that `14:00Z` is _inside_ in July (10:00 EDT)
and _outside_ in January (09:00 EST).

`workflow_dispatch` passes `--anytime`: a person pressing the button outranks a
window, and `AUTOMERGE_WINDOW` overrides the default for anyone whose hours are
not 10-to-10. An unreadable window (`AUTOMERGE_WINDOW=all-day`) exits non-zero
and holds every PR rather than silently merging around the clock.

## The token check now checks the token

A missing secret and an expired one used to fail differently: the first printed
the message that names the fix, the second got a `401` from each merge call. A
fine-grained PAT expires on a schedule, so the next consistent failure was
already on the books. The check now authenticates with the token against the
two reads the merge depends on — `repos/{repo}` for Contents and
`repos/{repo}/pulls` for Pull requests — and names whichever was rejected, so
an expired or under-scoped token says "mint a new PAT" rather than looking like
a code bug.

## Operator action: create the secret

At <https://github.com/settings/tokens?type=token>, **only** for this repo,
Contents: Read and write, Pull requests: Read and write, and the longest expiry
offered. Then:

```bash
gh secret set AUTOMERGE_TOKEN --repo agustinsacco/Phosphor < token.txt
```

Worth noting what a PAT is still required for, since a poll now re-evaluates the
queue on its own: `GITHUB_TOKEN` would merge, but a push made by it starts no
workflow, so the merge would land on main without CI — and Continuous Release
is driven off CI completing on main. The release would silently not ship.
