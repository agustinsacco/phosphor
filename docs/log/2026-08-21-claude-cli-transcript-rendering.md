# 2026-08-21 — Rendering Claude Code provider transcripts properly

Sessions on `@saccolabs/pi-claude-cli` carry two block shapes no pi-native
provider produces, and the transcript rendered both wrong. Found by reviewing
a real session, then quantified by running 16 real turns across all four
Claude families and feeding the resulting sessions through Phosphor's **own**
`hydrateFromMessages` + `buildTranscriptRows` + `summarizeActivity`.

## CLI-side tools were prose

Tools Claude Code runs inside its own process — WebSearch, WebFetch,
ToolSearch, the user's MCP servers, sub-agents — can't be pi tool calls,
because pi cannot execute them. The provider reports them as one-line marker
text blocks, which landed in the prose lane: raw JSON wrapped across
paragraphs, any URL inside auto-linkified as markdown, never collapsible,
never counted ("2 steps · ran 1 command" while three Claude Code tools ran).
Reproduced in **16/16** web-search turns across all four models.

`buildTranscriptRows` now parses the marker (`parseExternalToolMarker`) and
emits an `externalTool` activity step instead of a text row, so it groups and
collapses with pi's own tools, is counted in the summary ("claude code 2
tools"), and is never markdown-rendered. The argument preview stays an opaque
string — the provider truncates it, so it is frequently invalid JSON and must
never be parsed. The step type lives in `transcriptRows.ts` rather than
`AssistantBlock`, keeping the streaming reducer untouched.

## Encrypted thinking rendered as empty thoughts

Several models stream thinking as a multi-kilobyte signature with **no
plaintext** — measured with identical prompts at thinking medium: fable-5,
opus-5 and sonnet-5 all do it; haiku-4-5 is the only family that sends
readable thinking. pi recorded a thinking block with 0 characters, and the
transcript advertised "1 thought" that expanded to nothing — sometimes an
entire activity card containing nothing at all.

Fixed upstream in the provider (0.4.4, lazy materialization), but sessions
recorded before that fix are on disk forever and Phosphor hydrates them, so
`buildTranscriptRows` also skips empty thinking blocks on non-streaming
items. A streaming block is legitimately empty for a few frames, so the guard
is scoped to settled items.

## Coverage

`items/claudeCliRendering.test.ts` (7 tests) runs against
`__fixtures__/claude-cli-blocks.json`, trimmed from **real captured
sessions**: marker parsing including the truncated and no-argument forms,
markers never leaking into prose rows, the real answer surviving, no phantom
thoughts, summary counting, and a positive case proving genuine thinking
still renders.
