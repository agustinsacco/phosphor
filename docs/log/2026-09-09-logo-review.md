# The mark's concept is invisible at every size the mark is shown

A review of `build/icon.svg` against its rendered output rather than its
source, plus a fourth exploration round drawn from what the review found.

**Outcome: none of the twelve was adopted.** The round argued that the app's
own working indicator already solved the problem, and the conclusion drawn was
to stop drawing candidates and promote the indicator itself — see
[the beacon](2026-09-09-beacon-mark.md), later the same day. What follows is
the diagnosis that led there.

## What the rendering shows

Every element that carries the electron-shell concept renders below its
legibility floor at 16–128px, which is every OS surface an app icon appears in.

| Element     | Spec                | Composited | Contrast vs `#1f1c18` |
| ----------- | ------------------- | ---------- | --------------------- |
| Inner shell | `#eca03d` @ .16     | `#403118`  | 1.35:1                |
| Mid shell   | `#eca03d` @ .13     | `#3a2d1d`  | 1.26:1                |
| Outer shell | `#eca03d` @ .10     | `#33291c`  | 1.18:1                |
| Caption     | `#eca03d` @ .70     | `#ae7832`  | 4.47:1                |
| The P       | `#f2ab4e → #e2922e` | —          | 7.8:1 → 6.8:1         |

The caption's colour is fine; its size is not. `font-size 64/1024` is 6.25% of
tile height, so a 32px tile renders 2.0px type and a 128px dock icon renders
6.4px after the 824/1024 macOS inset. It is legible only above roughly a 160px
tile — which is the website hero and the 1024 art file, and nothing else.

The P was scaled to **0.62**, second-smallest in its own family (`e15-01` is
0.95), to clear room for rings that then render at 1.2:1. So what users
actually recognise is an amber P on graphite — which is `e15-01 Bare P`, the
candidate round three rejected.

## Three findings that are not about taste

- **The app and the website ship different marks.**
  `site/src/components/PhosphorMark.astro` draws 2 + 8 + 5 electron dots and
  animates them; `build/icon.svg` has none. The site version is the one that
  reads as an atom, it is not the canonical file, and nothing keeps the two in
  step. Two of its 8-shell dots also collide with the P's stem and bowl.
- **`site/public/favicon.svg` is a byte-identical copy of `build/icon.svg`**
  with no generator step and no diff test. The next mark revision regenerates
  eight platform binaries and silently leaves the browser tab on the old logo.
- **Nothing in `src/` draws the mark.** One reference app-wide,
  `electron/main.ts:55`, and it is a file path handed to `app.dock.setIcon`.
  The in-app monochrome variant has been specified since 2026-08-07 and is now
  owed by three consecutive identities, which makes it a process problem rather
  than a backlog item.

## One wording change worth making

`build/icon.svg`'s comment says the shells are "chemistry, not decoration…
don't retune the numbers for looks." The **radii** are chemistry — they step
evenly and `2 · 8 · 5` is phosphorus's configuration. The **opacities**
(.16 / .13 / .10) are not; nothing about phosphorus requires them. They are the
exact thing that needs raising, and as worded the comment protects them.

The clear-space rule in [style-guide.md](../style-guide.md) is also
unsatisfiable as written: "half the outer shell's diameter on all sides" is
340px around a 680px-wide mark on a 1024 tile, and 680 + 340 + 340 > 1024. It
needs restating as a ratio of the placed mark's width.

## Round four — orbit

Twelve candidates, written up in `docs/brand-explorations.md` with SVGs in
`docs/img/brand/orb-*.svg` — both deleted later the same day when
[the beacon](2026-09-09-beacon-mark.md) was adopted instead of any of them.
Recover them from git history if needed. The brief was different from rounds
one to three: follow **`PhosphorLoader`'s grammar** — a bright core, one
full-contrast travelling element, faint static structure behind them — and fuse
it with phosphorus. The loader survives at 20px in a lane; the mark does not
survive at 32px, and that grammar is the difference.

Every candidate was rasterized at 32px and inspected rather than assumed.
**02 Eclipse P, 03 Fifteen Rays and 07 Drawn P** survived cleanly; 04, 06 and
09 failed outright.

`07 Drawn P` was the interesting one — its bowl was a 296° orbit arc with a
leading head, so the icon and the spinner became the same object. That is the
observation the round was actually for, and taking it seriously makes all
twelve redundant: if the answer is "the icon should be the loader", then the
loader is the icon, and drawing a twelfth letterform is beside the point.

## Two traps found while drawing it

- **An SVG arc's large-arc-flag cannot be derived from `|a1 - a0|`.** Sweeping
  clockwise from 286° to 246° is 320°, not 40°, so the flag must come from the
  normalised sweep `(((a1 - a0) % 360) + 360) % 360`. Getting this wrong turned
  a bowl into a tick, and it rendered as a plausible-looking mark rather than
  as an error.
- **A circular bowl overlapping a bar reads as a lowercase `p`** at any
  proportion, because the junction is implicit. Two things fix it: a bowl at
  ~58–64% of cap height rather than 71%, and a square stem foot — a rounded one
  reads as a descender. The family P is 64% and square-cornered; copying both
  numbers is what made `orb-01` and `orb-07` read as capitals.
