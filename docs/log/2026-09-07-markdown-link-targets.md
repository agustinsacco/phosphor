# A link to a spec the model wrote went nowhere

A session wrote `docs/specs/headroom-compression.md`, then announced it in the
transcript as a markdown link. Clicking that link did nothing.

## What was wrong

Every link in model-authored markdown took the same path:

```tsx
onClick={(event) => {
  event.preventDefault()
  if (href) window.open(href) // main denies + opens externally
}}
```

That is right for `https://github.com/.../pull/214` and wrong for everything
else, because `window.open` resolves a relative href against the **renderer's
own document**:

- packaged, that is `file:///Applications/pidex.app/.../renderer/docs/specs/…`
  — a path that does not exist. The window-open handler denies it (not http),
  so the click is silently swallowed.
- in dev it is `http://localhost:5173/docs/specs/…`, which _is_ http, so the
  handler opened the user's browser on the Vite dev server, which 404s.

Either way the file pidex already knows how to display — it has a Files pane,
an editor and a `read` tool chip that opens both — was unreachable from the
message announcing it.

Two smaller holes came out of the same place. `mailto:` and custom schemes hit
`window.open` too and produced nothing. And nothing in the main process
guarded `will-navigate`, so any anchor that escaped the renderer's
`preventDefault` (a middle-click, a link rendered outside `Markdown`) could
replace the app document with a page that has no sidebar, no session and no
way back short of a reload.

## What it does now

`src/lib/markdownLink.ts` classifies an href before anything acts on it:

| href                        | target                        |
| --------------------------- | ----------------------------- |
| `https://…`, `http://…`     | default browser               |
| `docs/specs/x.md`, `./a.md` | Files pane, joined to the cwd |
| `/abs/path`, `file://…`     | Files pane                    |
| `src/lib/rpc.ts#L42`, `:42` | Files pane, at that line      |
| `#heading`, `mailto:`, …    | nothing                       |

A link with no scheme is read as a path, not as a bare domain: models write
`[docs](docs/x.md)` and `[GitHub](https://github.com)`, never
`[GitHub](github.com)`. A one-letter scheme is a Windows drive, not a scheme.

`MarkdownLink` renders a file link with **no `href` at all**, so there is no
navigation for a middle-click to perform, and calls the same
`openFileInWorkspace` the `read` chip and the fuzzy finder use.

Two supporting changes:

- `openFileInWorkspace` now reads the file **before** switching the pane. A
  markdown link can name a path that does not exist, and swapping panes first
  meant a failed open still hid whatever the user was looking at. The failure
  now toasts and leaves the layout alone.
- `electron/external-links.ts` holds one policy — http(s) only — shared by the
  window-open handler, the new `will-navigate` guard and `app:openExternal`.
  `isAppNavigation` compares the bundle directory rather than the origin for
  `file://`, because a packaged document's origin is the opaque `"null"` and
  origin equality would have let any file on disk load into the window.

## Not covered

Links inside an **HTML artifact** still do nothing: that iframe is
`sandbox="allow-scripts"`, with no `allow-popups`, and widening it would let
model-authored script call `window.open` in a loop. Markdown artifacts render
through `Markdown`, so their links follow the table above.
