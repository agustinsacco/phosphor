# Orchestrator tools that no Claude-provider session could call

2026-08-27

## What was broken

On the Claude Code provider, `fleet_status` and `memory_read` failed on every
call:

```
Validation failed for tool "fleet_status":
  - root: must be object

Received arguments:
""
```

The orchestrator then answered "what lanes do you see?" from Claude Code's own
`ListAgents` — peer Claude sessions, not Phosphor lanes — and told the user its
fleet view might be incomplete. The fleet tool has been dead on that provider
for as long as the provider has been in use.

## Why

A tool call with no arguments streams no `input_json_delta`. In
`@saccolabs/pi-claude-cli` (`src/event-bridge.ts`) the accumulated
`block.partialJson` is therefore `""`, `JSON.parse` throws, and the bridge
falls back to forwarding the raw string: `arguments: ""`. pi validates tool
arguments against the TypeBox schema **before** `execute` runs
(`pi-ai/dist/utils/validation.js`), so an empty-schema tool dies there and the
extension never runs.

It hits any tool whose fields are all optional, not just empty ones — the model
simply has to call it bare once.

## The fix here

Every tool in `pi-ext/orchestrator.ts` now declares at least one required
parameter, which forces the model to emit an object:

- `fleet_status({ scope })` — `all` | `blocked` | `idle`. The bridge filters,
  and an unknown value returns the whole fleet rather than an error: the field
  exists to shape the arguments, not to gate the answer.
- `memory_read({ purpose })` — one phrase, ignored by the host, visible in the
  transcript.
- `git_status({ workspacePath })` — was optional; `"."` means this project.

`pi-ext/orchestrator.test.ts` asserts the invariant for every registered tool,
so a new empty-schema tool fails the suite instead of failing silently on one
provider.

## The real fix, upstream

`JSON.parse(block.partialJson || "{}")` in `pi-claude-cli`'s
`event-bridge.ts`. That package is separately versioned and Phosphor pins nothing,
so the invariant above stays either way.
