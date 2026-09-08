# Worktree sessions that read the main checkout without noticing

2026-08-22

## Why

A session running in `.phosphor/worktrees/<name>` sometimes read a file out of the
**main checkout** instead of its own tree. The two are different branches, so
the model answered confidently about code that was not the code it was asked
about — and nothing anywhere said so.

Confirmed on two real sessions, and reproduced from their on-disk ledgers:

- **01a02ca0** (cwd `…/.phosphor/worktrees/read-src-features-chat-composer`), asked
  to read `src/features/chat/composer/ContextMeter.tsx`, called pi's `read` with
  `/home/agustinsacco/src/agustinsacco/Phosphor/src/features/chat/composer/ContextMeter.tsx`
  — the main checkout, sitting on `fix/composer-autogrow`, 19 commits behind
  main and predating PR #48. It then recommended building the burn badge that
  already existed at lines 80-109 of its own worktree's copy. 1 of 2 reads.
- **01a02c8e**: 2 of 12 reads went to the main checkout.

## What it was not

Both of the obvious suspects were checked and cleared:

- **The cwd is correct.** `registry.create(workspacePath, …)` passes it as the
  subprocess `cwd`, and the pi session header, the Claude CLI ledger records,
  and pi's system prompt all name the worktree. The Claude CLI subprocess
  inherits it too (`options?.cwd ?? process.cwd()` in the provider).
- **The system prompt does say so.** Captured from a live run by shimming the
  `claude` binary to dump its argv and `--system-prompt` file: pi ends its
  prompt with `Current working directory: …/.phosphor/worktrees/…`, and the
  project context arrives as `<project_instructions path="…/worktrees/…/CLAUDE.md">`.
  pi 0.84.2 already shadows the main checkout's `CLAUDE.md` for a nested
  worktree (`findShadowedContextFile`), so the main path is never fed in.

So nothing hands the model the main checkout's path. **It derives it.** The
model's own recorded reasoning names the correct _relative_ path
("The path is `src/features/chat/composer/ContextMeter.tsx`") and then emits an
absolute one. Two things combine:

1. It absolutises at all because Claude Code's tool discipline wants absolute
   paths — pi's `read` accepts "relative or absolute", but in `pi` prompt mode
   the provider substitutes Claude Code's tool documentation, and in `claude`
   mode Claude Code's own prompt is right there saying it.
2. It builds that absolute path from where it thinks the project root is, not
   from the cwd it was given. Phosphor puts worktrees at
   `<repo>/.phosphor/worktrees/<name>`, so the cwd _literally contains the main
   checkout as a prefix_, and `.phosphor/worktrees/<name>` reads like a tooling
   directory to trim. The shortened path exists, opens, and returns another
   branch's file — a wrong answer that looks exactly like a right one.

That is also why the raw `claude -p` control passed in the same worktree with
the same model: it is one turn against Claude Code's own prompt, which carries
an environment block naming the working directory. It narrows the odds; it does
not change the mechanism, which is why the leak was observed both before and
after `PI_CLAUDE_CLI_SYSTEM_PROMPT` was switched to `pi`.

## What changed

**Make it loud** — `pi-ext/worktree-paths.ts`, a third bundled extension loaded
into every session alongside `artifacts.ts` and `context-breakdown.ts`. On
`tool_call` for the path-bearing built-ins (`read`, `write`, `edit`, `ls`,
`grep`, `find`) it blocks the call when, and only when, all four hold:

1. the session cwd is a linked worktree (so there is a main checkout), and
2. the requested path resolves outside the cwd, and
3. it resolves inside that main checkout, and
4. the same repo-relative path exists inside the cwd.

The block reason names the file in the worktree. Nothing else is affected:
reading pi's docs, `~/.pi`, `/tmp`, or a main-checkout file with no counterpart
in the worktree all pass untouched, and a non-worktree session never even runs
the rule.

It **blocks rather than silently rewrites** — a silent correction just trades
one invisible behaviour for another. Asking for the identical path a second
time is honoured, which is the escape hatch for deliberately reading the main
checkout's copy ("diff mine against main").

**Make it less likely** — `pi:createSession` now passes
`--append-system-prompt` (`electron/pi/workspace-prompt.ts`) for worktree
sessions only: the working directory, the fact that the main checkout is a
different branch, and the instruction to build absolute paths by prefixing the
cwd verbatim rather than shortening it. Non-worktree sessions get nothing —
pi's own line already covers them, and every token here is spent per request.

## Verified

Live, in the worktree that produced session 01a02ca0, against
`claude-haiku-4-5` on the `pi-claude-cli` provider with `PI_CLAUDE_CLI_SYSTEM_PROMPT=pi`:
asked to read the main-checkout absolute path, the guard fired
(`BLOCK …/Phosphor/src/lib/burnRate.ts -> …/worktrees/read-src-features-chat-composer/src/lib/burnRate.ts`)
and the model immediately re-issued the read at the worktree path — one wasted
tool call, correct answer, same turn.

That `--append-system-prompt` survives into the prompt the CLI actually receives
was confirmed the same way the diagnosis was: via the argv shim, the block lands
between pi's prompt and `<project_context>`.

## Sharp edges

- The extension is the only Phosphor code that runs _inside_ pi's process and can
  refuse a tool call. Widening `PATH_TOOLS` or loosening the four conditions
  means blocking legitimate reads — pi's own system prompt instructs the model
  to read pi's docs from absolute paths well outside the cwd.
- **The guard sees pi's tools, not Claude Code's.** On the Claude Code provider
  the CLI's control protocol denies `mcp__custom-tools__*` so pi executes them
  (guarded) and _allows_ Claude Code's own internal tools, which run inside the
  CLI and never reach pi's `tool_call` hook. A leak through the CLI's own
  `Read` would be invisible here; only the prompt block covers that path.
  Neither observed session took it — every read in both went through pi's
  `read`, and neither ledger contains a single `[Claude Code · …]` marker — but
  it is the gap to close if this recurs, and closing it means an argv change in
  `@saccolabs/pi-claude-cli`, not in Phosphor.
- `pi-ext/*.ts` ships as `extraResources`, so the packaging filter now excludes
  `*.test.ts`; the rule's tests live beside it because pi loads each `-e` file
  standalone and a local import would not resolve.
