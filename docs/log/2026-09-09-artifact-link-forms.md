# An artifact URL is clickable in every form a model writes it

Date: 2026-09-09

Follow-up to [2026-09-08-artifact-links.md](2026-09-08-artifact-links.md),
which made `[Preview the design](artifact://phosphor-beacon)` open the
artifact.

## The report, and what it actually was

> "Context alignment artifact →" is not opening anything.

That link was `[**Context alignment artifact →**](artifact://aligned-context-windows)`,
the artifact `aligned-context-windows` existed in that session, and the click
did nothing.

It was **version lag, not a second bug**. The app was running 0.1.237
(`~/Library/Logs/Phosphor/phosphor.log`: `session start {"version":"0.1.237"}`,
`packaged":true`), and the fix above landed on main after that release was cut
— `git tag --contains 2913ae7` was empty while its CI run was still in
progress. The merged fix is real: the e2e test
`an artifact link the model wrote opens the Artifacts pane` passes against the
built app.

**Check the running version before re-debugging a link.** A packaged Phosphor
is usually several merges behind main, and a fix merged an hour ago has not
shipped.

## The gap that WAS still real

Counting every artifact URL across the sessions on disk
(`grep -rhoE` over `~/.pi/agent/sessions`), a third of them were never links at
all:

| Form                                 | Occurrences | Clickable before |
| ------------------------------------ | ----------- | ---------------- |
| `[text](artifact://x)` markdown link | 24          | yes              |
| `` `artifact://x` `` inline code     | 14          | **no**           |
| bare `artifact://x` in prose         | 0 observed  | no               |

The URL reads like an identifier, so models put it in backticks — most often in
exactly the sentence that announces the deliverable ("Delivered companion
artifact **Starfall Field Guide**: `artifact://starfall-field-guide`"). GFM
autolinks www/http/mailto only, so our scheme was plain text there. The message
named the artifact and gave no way to open it. The bare form is handled too,
for symmetry; it just has not been observed yet.

`src/lib/remarkArtifactLinks.ts` is a remark plugin, last in `REMARK_PLUGINS`
(after GFM has claimed the text it wants), that promotes both forms to link
nodes. From there they are ordinary artifact links: `urlTransform` passes
`artifact:` through, `classifyLink` resolves the id, `MarkdownLink` opens the
pane.

Deliberate limits, each with a test:

- **Inline code must be EXACTLY one URL.** `` `open artifact://x now` `` is
  prose about a command, not a link.
- **The link node wraps the `inlineCode` node**, so the code span keeps its
  mono styling and only gains a click target.
- **Trailing punctuation ends the URL.** `artifact://beacon.` links
  `artifact://beacon`; the id is slugified, and `beacon.` would slugify to
  `beacon-`, naming an artifact that does not exist.
- **A version suffix stays**: `artifact://beacon#v2` keeps `#v2`, which
  `classifyLink` reads.
- **Existing links are not re-entered**, and a message with no artifact URL
  keeps its original children array — an untouched message must not re-render.

Only `artifact:` is promoted. Bare file paths are NOT autolinked: models write
`` `src/lib/rpc.ts` `` constantly, and `npm run dev` looks the same to a
pattern loose enough to catch them all. A file the model links properly already
opens in the Files pane (`openFileInWorkspace`), covered by
`a link to a spec the model wrote opens it in the Files pane`.

Tests: `src/lib/remarkArtifactLinks.test.ts`; the e2e stub's artifact-link turn
now writes both forms in one message and `e2e/smoke.spec.ts` clicks each.
