# Headroom compression extension, phase 1

**Shipped:** `pi-ext/headroom.ts`, the sixth bundled extension — compresses
large JSON tool results through a local [Headroom](https://github.com/headroomlabs-ai/headroom)
proxy on pi's `tool_result` hook, at the moment they are produced. Inert
without `PHOSPHOR_HEADROOM_URL`; fails open on any proxy failure. Savings render
as an `Optimization · Headroom` section in the context meter
(`Phosphor-headroom` status key) and persist as `details.headroom` receipts in
the session file, which phase 2a folds for per-lane rollups.

Design and full measurements: [specs/headroom-compression.md](../specs/headroom-compression.md)
(the plan) and [specs/optimization-surface.md](../specs/optimization-surface.md)
(the UI to come).

The one rule worth restating here because it will look like an oversight
later: **the extension compresses only text that parses as a JSON object or
array.** This is not conservatism left over from planning — with the ml/code
extras installed, Headroom's default marker-free mode routes plain text to
transforms that are lossy without saying so (a grep result kept 3% of its
lines; `git log` prose lost individual words), while valid JSON is
lossless-or-noop by construction on that endpoint. Widening beyond JSON
requires `config.mode: "ccr"` plus a registered retrieve tool (round-trip
verified working on 0.37.0), not a relaxation of the gate.

Validated live on all three providers (Bedrock 44% accepted with receipt,
pi-claude-cli through the handoff broker, OpenRouter) and by a real
programming task in a worktree session with the extension loaded.
