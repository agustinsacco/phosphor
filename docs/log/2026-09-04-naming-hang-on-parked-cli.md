# Session auto-naming stopped the hour pi-claude-cli 0.7.0 landed

Sessions created after 2026-09-04 01:44 UTC kept their first-message title in
the sidebar and their first-message slug on the branch. The naming call was not
failing to produce a name. It was producing one and then being killed before
anyone read it.

## Evidence

`~/Library/Logs/Phosphor/phosphor.log`, real (non-stub) naming runs only:

```
2026-09-04T01:44:22.771Z [naming] generated a session name {"ms":9574,"title":"Investigate Failed Release Action"}
2026-09-04T01:50:21.489Z [naming] no session name {"ms":30002,"error":"timed out after 30000ms"}
2026-09-04T02:16:04.713Z [naming] no session name {"ms":30005,"error":"timed out after 30000ms"}
2026-09-04T02:23:15.271Z [naming] no session name {"ms":30004,"error":"timed out after 30000ms"}
```

Every run before that line succeeded (34 of them, 4s to 24s). Every run after
it timed out. `@saccolabs/pi-claude-cli` 0.7.0 was installed at
2026-09-04T01:44:08Z.

Reproduced against the real binary, instrumenting stdout and exit separately
with the naming argv from `titleArgs`:

```
+4579ms  STDOUT "Fix Sidebar Resize Handle\n"
+90003ms GIVING UP, killing
```

The title was complete at 4.6 seconds. The process was still alive at 90.

## Cause

0.7.0 keeps one Claude CLI process per pi session and, after `result`, **parks**
it for the next turn instead of ending it — `PI_CLAUDE_CLI_KEEPALIVE_MS`,
default ten minutes (`src/cli-process.ts`, `src/provider.ts`). The idle timer is
`unref`'d, but the parked child is not: it holds pi's event loop open. A
long-lived session wants exactly this. A one-shot `pi -p` has no next turn, so
it answers and then sits for ten minutes.

`runPrintMode` caps a run at 30 seconds, and on timeout it returned
`stdout: ''` — discarding a title it had held for 25 seconds.

Two independent faults, either of which alone would have broken naming.

The branch is collateral: `applyGeneratedName` does `if (!title) return` before
it reaches the rename, so no title means no branch rename, and the lane keeps
the slug of its first message.

## Fix

- `claudeOneShotEnv()` in `electron/pi/provider-detect.ts` returns
  `PI_CLAUDE_CLI_KEEPALIVE_MS=0`. Applied to the two one-shot spawns that can
  land on the Claude provider: the naming run in
  `electron/ipc/pi-session-handlers.ts` and `runClaudeProviderTest` in
  `electron/pi/packages.ts`. Sessions do **not** get it — `claudeProviderSpawnEnv()`
  is deliberately unchanged, because the park is what 0.7.0 is for.
- `runPrintMode` now returns whatever stdout arrived before a timeout. `stdout`
  and `error` can both be set; a caller that treats any error as "no answer" is
  unaffected (`electron/claude/usage.ts` does).

Verified: same argv with `PI_CLAUDE_CLI_KEEPALIVE_MS=0` printed at 4.9s and
exited clean at 5.4s.

The Settings → Packages "test the Claude provider" job had the same hang and no
timeout at all — it would have printed `Phosphor-provider-ok` and stayed a running
job for ten minutes. Same one-line fix.

## What the e2e stub cannot see

The stub prints and exits, so it is happy under either bug — the same blind spot
that hid the `execFile` hang in
[2026-08-26-session-start-ux.md](2026-08-26-session-start-ux.md). The guard is
`electron/pi/print-mode.test.ts`, which now also has a fixture that answers and
then refuses to exit.

## The general shape

This is the third time a naming failure has been silent and the second time the
cause was outside this repo. `@saccolabs/pi-claude-cli` is separately versioned
and Phosphor pins nothing, so a provider release changes Phosphor's behaviour with no
diff here. Check the installed version first:

```bash
jq -r .version ~/.pi/agent/npm/node_modules/@saccolabs/pi-claude-cli/package.json
```
