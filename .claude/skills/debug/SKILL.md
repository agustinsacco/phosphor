---
name: debug
description: Diagnose a Phosphor session that errors, hangs, or returns an empty reply — read the main-process debug log, pi's session JSONL, and the provider's own transcript. Use when a session "isn't working", a turn fails with a confusing message, pi crashes, or a provider (Claude CLI, Bedrock) misbehaves.
---

# Debugging a failing Phosphor session

Work outside-in. The layer that prints the error is usually not the layer that
caused it: a turn that fails inside the Claude CLI surfaces in Phosphor as a
generic red message, and the real reason is one or two layers down.

The stack, and what each layer keeps:

```
Phosphor renderer  →  chat bubble; keeps nothing after unmount
Phosphor main      →  ~/Library/Logs/Phosphor/phosphor.log   (spawn argv, pi stderr, crashes)
pi subprocess   →  ~/.pi/agent/sessions/<mangled-cwd>/<ts>_<id>.jsonl
provider        →  ~/.claude/projects/<mangled-cwd>/<session-id>.jsonl   (Claude CLI only)
```

## 1. The debug log

```bash
tail -100 ~/Library/Logs/Phosphor/phosphor.log
```

Always on, no flag to set — a log you must enable first is never on when the
bug happens. Rotates at 5MB keeping one `.1`. macOS path shown; Linux is
`~/.config/Phosphor/logs/`. From a shipped build the path is also available over
IPC (`app:debugLogPath`, `app:revealDebugLog`).

What it answers:

- `[pi] spawn` — the exact argv and cwd. Check `--provider`, `--model`,
  `--thinking` here before believing what the UI claims.
- `[pi] stderr` — the provider prints failure reasons here.
- `[pi] exited unexpectedly` — the code/signal behind a "pi crashed" banner.
- `[app] session start` — versions and **PATH**. A GUI app inherits launchd's
  PATH, not your login shell's, so `pi` or `claude` can resolve to a different
  binary (or none) than the same command in a terminal.

## 2. The pi session file

The session id and file path are in the UI, or find the newest:

```bash
ls -t ~/.pi/agent/sessions/*/*.jsonl | head -5
```

```bash
python3 -c "
import json,sys
for l in open(sys.argv[1]):
    d=json.loads(l); t=d.get('type'); m=d.get('message') or {}
    if t=='message':
        c=m.get('content') or []
        u=(m.get('usage') or {}).get('totalTokens')
        if not c: print(f'[{m.get(\"role\")}] EMPTY tokens={u} stop={m.get(\"stopReason\")}')
        for b in c: print(f'[{m.get(\"role\")}/{b.get(\"type\")}]', (b.get('text') or '')[:200])
    else: print(f'[{t}]', json.dumps({k:v for k,v in d.items() if k not in(\"type\",\"id\",\"parentId\")})[:150])
" <session.jsonl>
```

**An assistant message with empty content, `totalTokens: 0`, and a sub-second
timestamp gap means the model never ran.** The provider failed before the API
call. Do not read that as a model problem — go to step 3.

To tell a provider fault from a Phosphor fault, compare across sessions: if every
session on one provider is empty while another provider's sessions have real
token counts, the fault is that provider.

## 3. The provider's own transcript (Claude CLI)

**The highest-value file, and the one people forget.** When the provider is
`pi-claude-cli`, the CLI keeps its own transcript:

```
~/.claude/projects/<cwd-with-slashes-as-dashes>/<pi-session-id>.jsonl
```

It records the plain-English API error that Phosphor renders as something
unhelpful. Read the `result` field of the `type: "result"` line:

```bash
python3 -c "
import json,sys
for l in open(sys.argv[1]):
    d=json.loads(l)
    if d.get('type')=='result' or d.get('is_error'):
        for k in ('subtype','is_error','api_error_status','terminal_reason','result'):
            if k in d: print(f'{k} = {repr(d[k])[:400]}')
" <claude-transcript.jsonl>
```

Known trap: the provider's error template prints `subtype` while the check
that fired is `is_error`, producing the self-contradictory
**`Error: Claude CLI returned success`**. The real cause is in `result`, which
the provider never surfaces. Any confusing provider error — always read
`result`.

## 4. Reproduce outside Phosphor

This decides "is it Phosphor or is it pi/the provider" in one command:

```bash
cd /tmp && echo "reply with exactly: pong" | pi -p
```

Fails here too ⇒ not a Phosphor bug. Fix pi, the provider, or its config.
Works here but fails in Phosphor ⇒ compare the `[pi] spawn` argv from the debug
log against what you just ran; the difference is the bug.

## 5. Capture the real argv of a nested CLI

When a provider shells out (`pi-claude-cli` spawns `claude`) and you need the
arguments it actually passed, shim the binary:

```bash
mkdir -p /tmp/shim && cat > /tmp/shim/claude <<'EOF'
#!/bin/sh
for a in "$@"; do echo "  [$a]"; done > /tmp/claude-argv.txt
exec /full/path/to/real/claude "$@"
EOF
chmod +x /tmp/shim/claude
PATH=/tmp/shim:$PATH pi -p <<< "hi"; cat /tmp/claude-argv.txt
```

Use the absolute path to the real binary in the `exec` line, and remove the
shim afterwards. Several `claude` binaries at different versions on one PATH
is common (homebrew, fnm, `~/.local/bin`) — `which -a claude` before assuming
which one ran.

## Checks worth running early

```bash
which -a pi claude          # multiple versions on PATH?
pi --version                # >= 0.78.0
cat ~/.pi/agent/settings.json      # defaultProvider, defaultModel, thinking level
cat ~/.claude/settings.json        # provider-side settings can veto pi's flags
```

A setting on **either** side can break the other. A real case:
`"alwaysThinkingEnabled": false` in `~/.claude/settings.json` made the CLI
reject pi's `--effort max`, and every turn failed. Neither file is wrong on its
own — they were incompatible.
