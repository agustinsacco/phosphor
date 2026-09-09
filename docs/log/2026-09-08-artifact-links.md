# `artifact://` links in chat open the artifact

Date: 2026-09-08

## The symptom

A model finished a deliverable, then wrote

```markdown
[Preview the design](artifact://phosphor-beacon)
```

and the link did nothing. No pane, no file, no error. Clicking it repeatedly
looked like a broken app: the artifact existed, the pane existed, and the
sentence pointing at it was dead.

## Why it was dead — two layers, and the second one is the trap

`src/lib/markdownLink.ts` classifies every link in model-authored markdown into
web URL, repo path, in-document anchor, or refused. `artifact:` fell into
**refused** — the same bucket as `javascript:` — so `MarkdownLink` called
`preventDefault()` and returned. The link was inert by construction.

Teaching the classifier the scheme was **not enough**. react-markdown runs its
own `defaultUrlTransform` over every href first, and it keeps only web-safe
protocols (`http`, `https`, `irc`, `ircs`, `mailto`, `xmpp`). Everything else
becomes `''`. So `MarkdownLink` was receiving an EMPTY href, not
`artifact://phosphor-beacon`, and the fixed classifier still saw nothing to
classify. The e2e run is what surfaced it: the rendered anchor was
`<a href="">`, with no title, from a code path that sets no href at all.

The model was not making the convention up out of nowhere. `artifact_create`'s
own description told it to "hand the user the link", and no link syntax
existed, so it invented the obvious one. The renderer had never heard of it.

## The fix

`artifact://<id>` is now a real target:

- `artifactUrlTransform` (also in `src/lib/markdownLink.ts`) is passed to
  `ReactMarkdown` as `urlTransform`. It lets `artifact:` through and defers to
  `defaultUrlTransform` for everything else, so `javascript:` and friends are
  still stripped there.
- `classifyLink` returns `{ kind: 'artifact', id, version? }`. `artifact:id`
  works as well as `artifact://id`, and a trailing `#v2` or `@v2` names a
  version. The id is slugified with the same rules as
  `slugifyArtifactId` in `pi-ext/artifacts.ts`, so a link written from the
  title (`artifact://Phosphor%20Beacon`) still resolves.
- `openArtifact(sessionId, id, version)` in `src/stores/artifacts.ts` selects
  the artifact, clears its unseen badge, and opens the pane **for that
  session**. It returns false when the session has no such artifact, and
  `MarkdownLink` then toasts `No artifact "<id>" in this session` rather than
  failing silently — a chat link can name an id from before a fork.
- The link carries no `href`, like a file link, so no middle-click can
  navigate the app to a non-route.
- `pi-ext/artifacts.ts` now names the syntax in the tool description, in the
  prompt guidelines, and in the `artifact_create` result text, so the
  convention is stated instead of guessed.

File links were already working (`openFileInWorkspace` → Files pane); they were
not the failure here.

Tests: `src/lib/markdownLink.test.ts`,
`src/components/markdown/MarkdownLink.test.tsx`.

Follow-up: this covered the markdown-link form only. A third of the artifact
URLs models write are inline code (`` `artifact://x` ``) and were still dead
text — see
[2026-09-09-artifact-link-forms.md](2026-09-09-artifact-link-forms.md).
