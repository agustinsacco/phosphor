# Site films

Reproducible sources for the three silent, text-led films on the Phosphor site. Each film is a
[Hyperframes](https://github.com/heygen-com/hyperframes) project: HTML scenes with GSAP timelines
that the CLI seeks frame by frame and encodes locally. The site embeds only the rendered files,
with native controls; no player or runtime ships to the browser.

| Film                | Length | Shipped as                                            |
| ------------------- | ------ | ----------------------------------------------------- |
| `phosphor-overview` | 25 s   | `apps/site/public/media/phosphor-overview.{mp4,webp}` |
| `brain-walkthrough` | 39 s   | `apps/site/public/media/brain-walkthrough.{mp4,webp}` |
| `lane-to-review`    | 35 s   | `apps/site/public/media/lane-to-review.{mp4,webp}`    |

All are 1280×720 at 30 fps, H.264 High / `yuv420p`, no audio track, `moov` before `mdat`.
[`media.json`](media.json) records the bytes and SHA-256 of what shipped, and of every capture the
films were rendered from.

## What is real

Every product pixel is one of the repository's own captures (`docs/img/*.png`): the current
renderer over fictional fixtures, described in `apps/site/scripts/CAPTURES.md`. A film may crop a
capture, move a camera over it, outline a control, and replace one capture with another where the
interface would change. Nothing in the interface is drawn, retouched or composited. The cursor,
the outlines, the copy column and the end card are the film's own, and every scene that shows the
product carries the line `Product demo · fictional data`.

The cursor shows where a control is, not a recorded session. No film claims a speed, a model
result or a completion time, and the copy follows the limits in the living docs (Brain is opt-in
and Desktop only, extraction calls the lane's provider, PR hand-offs are drafts, a missing check
is not a pass, Slack pills are links, Hosts are your own machines).

## Layout

```text
films.json            the three films: length, poster frame, the captures each one uses
shared/film.css       the one look: Phosphor's dark tokens, copy column, app window
shared/kit.js         the motion vocabulary scenes call as window.PX
films/<id>/index.html the root composition: one host per scene
films/<id>/compositions/<scene>.html   one scene each, markup and timeline together
scripts/sync-assets.mjs   fills each film's git-ignored assets/
scripts/build-films.mjs   check, render, poster, verify, record
scripts/films.test.mjs    source rules and the shipped-media record
STORYBOARD.md, SPEC.md, REVIEW.md      what each film says, how it looks, what was checked
```

`films/<id>/assets/` is not in git. `sync-assets.mjs` copies it from the things that own each
part: `shared/`, the site's font files, the generated favicon and the captures. A film therefore
cannot drift from the site it plays on, and no capture is stored twice.

## Reproduce

Needs Node ≥ 22.19 and FFmpeg with `libx264` and `libwebp` on `PATH`. Hyperframes is pinned to
`0.9.49` in `package.json` and its lockfile; it renders through a headless Chrome, which
`npx hyperframes browser ensure` installs once per machine.

```sh
cd tools/marketing
npm ci
npm test            # source rules, and that shipped media matches media.json
npm run check       # sync assets, then `hyperframes check` on each film
npm run build       # check, render to apps/site/public/media, cut posters, rewrite media.json
npm run verify      # ffprobe the shipped files against the delivery contract
```

`npm run build -- lane-to-review` builds one film. Captures come from `docs/img`; set
`PHOSPHOR_FILM_PLATES=/path/to/docs/img` to read another checkout's. The scripts always start
the CLI with `HYPERFRAMES_NO_TELEMETRY=1 DO_NOT_TRACK=1 HYPERFRAMES_NO_UPDATE_CHECK=1
HYPERFRAMES_NO_AUTO_INSTALL=1`. Rendering is local only; never use `cloud`, `share`, `publish`
or `feedback` here.

To look at a film while editing: `cd films/<id> && npx hyperframes preview`, and
`npx hyperframes snapshot --at 1,4,9` writes stills under `.hyperframes/`.

A render is not byte-reproducible across machines (Chrome and x264 versions differ), so rebuilds
change the hashes in `media.json`; commit the media and the record together.

## Editing a film

- Coordinates are capture pixels. `cam.cut([x, y, w, h])` frames that rectangle of the original
  capture; rings are positioned in the same space. Brain plates include settings dialogs, page
  captures and a cropped What changed panel, each framed at its own dimensions. A re-captured screen with a different layout
  needs its rectangles revisited: open the PNG and read them off.
- A line of copy holds about 0.5 s plus 0.3 s a word. `hyperframes check` reports one that does not.
- A scene's slot in `index.html` and its `data-duration` in `films.json` must agree; the tests say
  so when they do not.
- When the on-screen copy changes, update `STORYBOARD.md` and the matching steps in
  `apps/site/src/lib/films.ts`, which is the text alternative the page shows.
