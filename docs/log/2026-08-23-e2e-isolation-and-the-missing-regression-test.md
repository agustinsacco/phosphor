# 2026-08-23 — The e2e suite was lying twice

Reviewing [2026-08-22-fast-session-start.md](2026-08-22-fast-session-start.md)
after it landed turned up two problems, both in the test suite rather than the
product, and both of the same shape: a test that reported success it had not
earned.

## The regression test that could not fail

That change fixed a real bug — right-click did nothing on a chat you had just
started, because the sidebar row stayed a `PendingSessionRow` (which has no
context menu by design) and the watcher meant to promote it was attached to a
session directory that did not exist yet. chokidar never revisits a missing
target, so the promotion never came.

The fix was covered by `session-watcher.test.ts`, which does genuinely fail
without it. But nothing covered the **symptom**, so an attempt to add that
coverage was the useful part of the review: the obvious test — start a chat,
right-click the new row — passes against the _unfixed_ code just as happily as
the fixed code.

The reason is the stub. `pi-stub.cjs` created its session directory and file
**synchronously at startup**, so the directory was always on disk before Phosphor
could attach a watcher to it. The gap the bug lives in never opened. Any test
written against that stub was measuring nothing.

`PHOSPHOR_E2E_SESSION_WRITE_DELAY_MS` now defers the write, and the new test
(`a session whose file lands late still becomes a real, right-clickable row`)
asserts the row leaves the placeholder state and answers a right-click
**without switching session and back** — which is exactly how the bug was
originally described. Verified to fail with the `mkdir`-before-watch and the
`bootstrapSession` re-scan both removed, and to pass with them.

The general lesson is worth keeping: a fixture that is _more reliable_ than
production is not a neutral simplification. It silently deletes the states
worth testing.

## The "intermittent" that was the suite shelling out to the real pi

The same log wrote off a run-wide e2e failure as flakiness on a machine with no
`xvfb`. It was not. `extensions tab lists pi packages` failed reproducibly in
the full suite and passed alone, which is the signature of shared state, not
load.

Diagnostics caught it mid-test: the fixture package the test had just written
was **gone**, and `@saccolabs/pi-claude-cli@0.4.7` had appeared in its place
along with a full transitive dependency tree and a `package-lock.json` that no
test wrote.

```
DIAG pkgDir exists: false
DIAG packages:list: [{"spec":"npm:demo-pack", ... "installed":false},
                     {"spec":"npm:@saccolabs/pi-claude-cli","version":"0.4.7","installed":true}]
```

Something had run a **real, networked `npm install`** into the sandboxed agent
dir, and npm — which owns `node_modules` — pruned the hand-written fixture for
not being in its manifest.

That something was `pi:catalogueModels`. It resolved its binary straight from
`checkPiHealth()` and never consulted `PHOSPHOR_PI_STUB`, making it the only pi
spawn in the app that ignored the stub. Opening a model picker therefore booted
the **real** pi against the test's agent dir, and real pi installs whatever
`settings.json` declares. The `auth.json` and `models-store.json` sitting in
those temp dirs were the other half of the evidence — the comment on
`listModelsViaRpc` claimed "nothing here touches the filesystem", which was
simply untrue.

Two fixes, at different depths:

- `piStubPath()` moved to `electron/pi/stub.ts` and `pi:catalogueModels` now
  honors it, so no e2e run reaches the network. That gate is security-relevant
  (it is env-var-triggered code execution in the main process, gated on
  `!app.isPackaged`), and it should never have had two homes — the copy is
  exactly how one handler got missed.
- `launch({ agentDir })` takes an override and every test that seeds or mutates
  an agent dir gets its own (`privateAgentDir`). Isolation alone did **not**
  fix the flake — the offending install was triggered by the failing test's own
  settings — but it stops the tests coupling to each other at all, and fixes a
  quieter leak in the MCP test, which wrote a global `mcp.json` and never
  removed it, handing every later test an MCP server it never asked for.

Ordering the tests would have been the wrong fix: it leaves the coupling in
place and waits for the next person to trip on it.

## The click that was never delivered

With that fixed, a third failure surfaced — `resource monitor reports real
per-session process usage`, 2 failures in 4 runs. This one had already been
"fixed" once, by swapping `uncheck()` for a click plus a polled assertion, on
the theory that the controlled input merely re-rendered late.

It does not re-render late. The checkbox stays checked for the full ten-second
poll, because the click never reached it. The monitor re-renders on every
sampling tick and the totals block above the checkbox grows as history
accumulates, so the checkbox drifts downward; Playwright resolves the element,
waits for stability, then dispatches at those coordinates, and a sample landing
in that gap moves the target out from under the event.

No amount of polling repairs a click that was never delivered — the distinction
matters, because the previous fix treated a lost event as a slow one.
`setCheckbox` retries the click, guarded on current state so a landed click is
never undone. 6 consecutive passes, from 2-in-4 failing.

## Two things worth knowing about this suite

- **CI retries once (`retries: process.env.CI ? 1 : 0`); local never does.** A
  first-attempt failure is invisible in a green CI run. Both problems above sat
  behind a green checkmark.
- **CI runs under `xvfb` and a developer machine may not.** `scripts/e2e.sh`
  falls back to unmapped windows, which is ~2-3x slower and surfaces races CI
  cannot see. "Green on CI" and "green locally" are different claims.
