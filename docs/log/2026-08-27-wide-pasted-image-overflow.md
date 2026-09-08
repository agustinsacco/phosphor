# A pasted wide image painted over the transcript

Reported as "pasting images breaks the tool group and ui a bit", with a
screenshot of the app in that state. The screenshot itself was the evidence:
two pasted images had grown out of the transcript column, across the rows
beside them, and were cut off at the pane's left edge.

## What broke

`ChatImage` capped **height only**. Every caller passes a `max-h-*` and nothing
else — `max-h-40` for a user message, `max-h-32` for an extension message — and
the wrapper is `inline-flex shrink-0`, i.e. a box that hugs whatever the `<img>`
resolves to. Nothing bounded the width.

That is invisible for a normal screenshot: a 3000x1600 window capture at 160px
tall is 300px wide and sits comfortably inside the 720px column. It breaks for a
**cropped strip** — a screenshot of just a composer, or just a status bar,
aspect 8:1 or worse. At 160px tall that is over 1600px wide.

The user-message row is `flex flex-wrap justify-end` inside an absolutely
positioned, fixed-width virtualizer row, so the overflow grew **leftwards**:
over the column's left edge, over the activity group's left edge below it,
and then clipped by the scroller. Most of the image was unviewable, and the
transcript's left margin was gone for as long as that row was on screen.

Row heights stayed correct throughout, so this was never vertical overlap —
purely horizontal blowout. The image was also still clickable, so the lightbox
was the only way to see the parts that had been clipped.

## What changed

- `max-w-full` on both the wrapper button and the `<img>`
  (`src/features/chat/ChatImage.tsx`). One change fixes every surface: chat and
  home composer attachments, user messages, extension messages, and
  `StartingChat`'s echo. The intrinsic ratio then supplies the height, so the
  1800x200 fixture lands at 720x80 instead of 1440x160.

  `shrink-0` stays. `max-width` is a hard clamp in the flex algorithm
  independently of `flex-shrink`, and dropping it would let the composer's
  fixed 16x16 thumbnail row squash under a long paste.

- The data URL is now `useMemo`'d on `(mimeType, data)`. `imageUrl` copies the
  whole base64 payload into a fresh string, and a pasted screenshot is 1-2MB of
  it (measured across the real sessions on this machine: 43KB to 1.88MB, median
  ~600KB). It ran on every render, and `MessageList` re-renders on every token
  because the `tools` record it passes down changes identity on each tool
  update. Same pixels, an allocation per image per token.

## Verification

The e2e (`a pasted wide image stays inside the transcript column`) asserts
geometry, not classes: the rendered image's box must sit inside the scroller's
box. Proven non-vacuous by reverting the two class changes and rebuilding —
it fails with `expect(1440).toBeLessThanOrEqual(648)`.

typecheck / lint / format / 1212 unit tests / 30 e2e all pass.

## Not this change

The same screenshot showed the lane loop's `{"rungs":[…]}` payload printed
across the foot of the window. That is the bug fixed the same morning in
[#88](https://github.com/agustinsacco/Phosphor/pull/88) (`2002d12`); the reporting
build predates it.
