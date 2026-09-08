# 2026-08-29 — Live verification: how pi-claude-cli drives Claude Code, and exactly what was broken

> **Second correction, same day, after re-verifying with real limits
> restored.** Everything below up to "The fix, as shipped in 0.4.15" describes
> the FIRST bug found and fixed (PR #27, 0.4.15): the CLI drops
> `--system-prompt` across `--resume`, causing a turn-2 cache rebuild. That
> diagnosis and fix were correct as far as cost goes.
>
> But re-verifying it live turned up a SECOND, older, and worse bug:
> `--system-prompt` / `--append-system-prompt` take a **literal string**, not
> a path, and the provider has always passed them a **temp-file path**. So pi's
> actual instructions have never reached Claude Code, on any turn, since this
> provider first supported a system prompt — not just from turn 2 as 0.4.15
> believed, but from turn 1 too, on every session ever run. 0.4.15's fix
> re-sent the same broken flag, so it fixed the cache cost but not the missing
> instructions. Fixed in **0.4.16**
> ([PR #28](https://github.com/agustinsacco/pi-claude-cli/pull/28)). See
> "Second bug, found on live re-verification" below for the full account —
> read that section first if you only have time for one.

Verdict: **the defect was real, and is now fixed and shipped** in
`@saccolabs/pi-claude-cli` 0.4.15
([PR #27](https://github.com/agustinsacco/pi-claude-cli/pull/27)). It was
smaller and different than this audit first claimed. The kill-and-resume
mechanism itself is cache-continuous — steady-state turn boundaries cost
**21–173 tokens**. The whole measured waste came from one bug: **the provider
passed `--system-prompt` only on the first spawn, and the CLI does not persist
it across `--resume`.** So turn 2 rebuilt the request under Claude Code's
default system prompt, re-billing the entire transcript once per session —
and every turn after turn 1 ran under the wrong instructions.

The fix was mechanically verified before being written: re-passing the same
system prompt on resume spawns drops the turn-2 cost from 9,761 to **112
tokens** and keeps pi's instructions live. It was a small provider change, not
the persistent-process rewrite this audit originally proposed.

**This verdict was incomplete — see the box above.**

## How pi manages Claude Code

```
Phosphor (Electron main)
  └─ spawns once per session:  pi --mode rpc [--no-context-files] -e …ext…
       └─ pi-claude-cli provider, per USER TURN:
            1. spawn claude -p …  (--session-id on turn 1, --resume after)
            2. write ONE stream-json user message to stdin (the delta only)
            3. read stream-json events until the turn ends
            4. SIGKILL the claude process (cleanupProcess)
       (next turn → back to 1, same session id)
```

One `pi` process per session; one `claude` process per turn. State between
turns lives in the CLI's own transcript
(`~/.claude/projects/<mangled-cwd>/<id>.jsonl`), reloaded by `--resume`.

## The exact commands, captured via a shim `claude` on PATH

Turn 1:

```
claude -p --input-format stream-json --output-format stream-json --verbose
  --include-partial-messages --model claude-haiku-4-5
  --permission-prompt-tool stdio --disallowedTools AskUserQuestion
  --session-id 1649895b-…
  --system-prompt /tmp/…/pi-claude-cli-sysprompt-<pid>.txt      ← present
  --effort max --mcp-config /tmp/…/pi-claude-mcp-config-<pid>.json
```

stdin: `{"type":"user","message":{"role":"user","content":"USER:\nReply with exactly the word ALPHA and nothing else."}}`

Turn 2+, **0.4.14 (broken)**:

```
claude -p … (identical) … --resume 1649895b-…                    ← no --system-prompt
  --effort max --mcp-config …
```

Turn 2+, **0.4.15 (fixed)**: identical, plus the prompt flag again, pointing
at the bytes the session was created with:

```
claude -p … --resume 1649895b-…
  --system-prompt /tmp/…/pi-claude-cli-sysprompt-<pid>-<cli-session-id>.txt
```

stdin: `{"type":"user","message":{"role":"user","content":"Reply with exactly the word BRAVO and nothing else."}}`

## Measurements (all deduped on requestId)

Four independent live runs, 3-second turn gaps, shim capturing every spawn.

**A. Haiku, 3 turns** (`ws3`):

| turn | create    | read   | total  | note                                      |
| ---- | --------- | ------ | ------ | ----------------------------------------- |
| 1    | 5,762     | 15,797 | 21,569 | pi's system prompt                        |
| 2    | **9,844** | 18,101 | 27,955 | swap to CLI default prompt — full re-bill |
| 3    | **55**    | 27,945 | 28,010 | steady state: continuous                  |

**B. Haiku, 4 turns with a CLI-native Read tool call in turn 2** (`ws4`):
boundaries after the tool turn cost 132 and 62 tokens — tool turns do not
break resume.

**C. Opus 5, 3 turns** (`ws5`): 7,633 / **10,399** / **21**. Same shape on
the production model.

**D. Pure CLI, no pi at all** (`claude -p --session-id` then
`claude -p --resume`, typed by hand): 5,627 / 9,761 — identical to the
pi-driven numbers within ~100 tokens. pi is using the CLI exactly as a
terminal headless user would; nothing about the invocation is malformed.

**E. The fix, mechanically verified**: `claude -p --resume <id>
--system-prompt <same file>` is accepted, answers correctly, and costs
**create 112 / read 21,424** — it re-matched the turn-1-shaped cache prefix
and re-billed only the delta. Same file on every spawn = continuity + correct
instructions.

## Re-reading the production sessions with this lens

Every large rebuild in the two audited real sessions is now explained:

| session  | boundary             | create | classification                    |
| -------- | -------------------- | ------ | --------------------------------- |
| d27393ac | 19:24 (turn 2, +86s) | 44,518 | **system-prompt swap**            |
| d27393ac | 22:04 (+2h40m)       | 45,309 | 1h cache TTL expiry — unavoidable |
| 2a8d559a | 22:05 (turn 2, +2m)  | 69,709 | **system-prompt swap**            |

Continuity check: 2a8d559a's turn-1 context ended at ~85.6k; turn 2 read
15,855 (the CLI's fixed default prefix, cached globally) + created 69,709 =
85,564. The entire non-default portion re-billed, exactly once.

The audit's earlier claim of "median 35,300 lost on 71% of boundaries" was
an over-generalization: Phosphor sessions are typically short, so turn-2 swap
boundaries and TTL expiries dominated that sample. Steady-state boundaries
are fine.

## Consequences beyond cost

The swap was a correctness bug, not just a billing one. On 0.4.14, from turn 2
onward:

- In `PI_CLAUDE_CLI_SYSTEM_PROMPT=pi` (replace) mode, the session ran under
  Claude Code's default prompt, not pi's.
- In `claude` (append) mode, pi's appended directives — Phosphor's lane
  charter, subagent policy, prompt-level worktree guidance — vanished.
  (The worktree-paths PreToolUse hook survived; it rides
  `PI_CLAUDE_CLI_SETTINGS`, which is passed on every spawn.)

## Is this "Claude Code exactly as on a terminal"?

|                  | terminal `claude` (interactive) | via pi-claude-cli 0.4.15                                                    |
| ---------------- | ------------------------------- | --------------------------------------------------------------------------- |
| invocation       | TTY session                     | `-p` + stream-json — documented headless mode, reproduced by hand in test D |
| process lifetime | one process                     | one per turn, SIGKILL between                                               |
| prompt cache     | continuous                      | continuous, except >1h TTL expiry                                           |
| system prompt    | constant                        | constant (0.4.14 lost it after turn 1)                                      |
| permissions      | interactive                     | `--permission-prompt-tool stdio`, `AskUserQuestion` disallowed (no TUI)     |

Answer to the original question: **no, Claude Code does not burn more tokens
via Phosphor than on its own** — once 0.4.15 is installed. The static prefix is
slightly _smaller_ than a bare `claude -p` in the same cwd (31,698 vs 33,421),
because pi replaces Claude Code's system prompt rather than appending to it.

## The fix, as shipped in 0.4.15

The system prompt goes on **every** spawn. Because re-passing is only cheap
when the bytes are identical — and `buildSystemPrompt()` is not byte-stable
across turns, appending a tool-results paragraph once history holds a
`toolResult` — the prompt a CLI session is created with is stored at
`~/.pi/agent/pi-claude-cli/sysprompt/<cli-session-id>.txt` and replayed
verbatim for that session's life. Sessions created on 0.4.14 fall back to a
rebuild: less cacheable, still correct.

The staging temp file is now keyed by CLI session rather than pid alone, since
writing it every spawn would otherwise let concurrent turns (pi's sub-agents)
clobber each other's prompt.

Guard: `tests/resume-argv.test.ts` in the provider repo spawns the real stub
CLI — no mocks, no tokens — and asserts the resumed argv carries a
byte-identical prompt. Confirmed to fail on 0.4.14's behaviour and pass on
0.4.15's. Note that the pre-existing live suite already asserted
`cacheWrite < 2000` on a resumed turn and would have caught this, but it is
gated behind `PI_CLAUDE_CLI_LIVE=1` and excluded from CI, so it never ran.

### Verification of the shipped artifact

Live re-measurement was not possible after the fix — the account hit its
monthly spend limit mid-investigation. Instead: the installed
`~/.pi/agent/npm/node_modules/@saccolabs/pi-claude-cli/src` is byte-identical
(`diff -r`) to merge commit `336f81a`, on which the full suite passes
including the real-spawn argv guard. Worth one live run once the limit resets.

## Second bug, found on live re-verification: the flag was ALWAYS wrong

The verification of 0.4.15 above proved cache-continuity (`create 112 / read
21,424`) and that a follow-up question got _an_ answer. It never proved the
answer used pi's system prompt, because the probe question ("reply with
BRAVO") didn't require the system prompt to answer correctly. That gap is
what let this second bug through the first verification pass.

Once real API limits were available again, re-running the live suite
(`PI_CLAUDE_CLI_LIVE=1`) against the actually-installed 0.4.15 package hit a
distinguishing probe: assign the model a fictitious codename via the system
prompt, then ask for it.

```
$ claude -p --model claude-haiku-4-5 --system-prompt /tmp/sys.txt "What is your codename?"
I'm Claude, made by Anthropic. No codename—just Claude.

$ claude -p --model claude-haiku-4-5 --system-prompt "$(cat /tmp/sys.txt)" "What is your codename?"
Bartholomew Quirk.
```

`--system-prompt` (and `--append-system-prompt`) take a **literal string**.
`claude --help` names the real path-taking flags separately:
`--system-prompt-file` / `--append-system-prompt-file`. `spawnClaude()` in
`process-manager.ts` has, since the provider first grew system-prompt support
(long before 2026-08-29), written the prompt to a temp file and handed the
**path** to the unsuffixed, string-only flag. No error, no warning — the CLI
just silently ran on Claude Code's default prompt (`pi` mode) or appended a
stray filesystem path as noise the model ignored (`claude` mode).

This is strictly worse than what PR #27 diagnosed: it isn't a turn-2 problem,
it's a turn-1 problem, present in every Phosphor Claude-provider session that
has ever run, on both `PI_CLAUDE_CLI_SYSTEM_PROMPT` modes, independent of
resume. pi's instructions — replaced or appended — never reached the model at
all. 0.4.15's fix (re-send the prompt on every `--resume`) was necessary and
its cache-cost math was correct, but it re-sent the same broken flag, so a
0.4.15 session still ran on Claude Code's defaults from turn 1 onward.

**Fixed in 0.4.16** ([PR #28](https://github.com/agustinsacco/pi-claude-cli/pull/28)):
switch to `--system-prompt-file` / `--append-system-prompt-file`. Verified
live against the installed 0.4.16, both prompt modes, turn 1 through a resume
boundary:

| mode                           | turn 1 reply         | turn 2 reply (post-resume) | turn-2 cacheWrite |
| ------------------------------ | -------------------- | -------------------------- | ----------------- |
| `pi` (`--system-prompt-file`)  | "Bartholomew Quirk." | "Bartholomew Quirk."       | 76                |
| `claude` (`--append-...-file`) | "Bartholomew Quirk." | "Bartholomew Quirk."       | 121               |

Cache stays warm either way — this is a pure correctness fix layered on top
of 0.4.15's cost fix, not a second cache regression.

**Why the mocked tests never caught it, on either PR.** Every existing
`process-manager.test.ts` / `provider.test.ts` assertion checked that a flag
was _present_ in the spawned argv. None of them, nor the mocked half of
`resume-argv.test.ts`, ever ran a real CLI process and checked what the model
actually received. Only a live run — real subprocess, real model, a
distinguishing question — surfaces it. 0.4.16 adds a mocked guard too (assert
the staged file's _content_, not just its presence, and that neither
unsuffixed flag is ever used), but the mocked guard is a regression net, not
what found the bug.

**Corrected verdict.** No, Claude Code does not use more tokens through Phosphor
than on its own — that holds on 0.4.16 as it did on 0.4.15, the token math in
this doc is unaffected. But the "constant, correct system prompt" row of the
terminal-parity table above was wrong until 0.4.16: on 0.4.14 and 0.4.15,
every Phosphor Claude-provider session ran fully or partially on Claude Code's
own instructions, not pi's, for its entire lifetime.

## Repro harness

`/tmp/pi-lifecycle-test/`: `bin/claude` (argv + stdin logging shim),
`drive3/4/5.mjs` (turn drivers), `capture/` (logs), `ws*/` (workspaces).
Reading CLI transcripts: always dedupe assistant rows on `requestId`
(2–3× duplicates) before summing usage.
