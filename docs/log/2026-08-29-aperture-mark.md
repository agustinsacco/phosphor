# The prompt bubble said the wrong thing about the product

The mark shipped 2026-08-07 was a chat bubble carrying a `>_`. Both halves are
stock: the bubble is the shape of a customer-support widget, and `>_` is the
most-used glyph in developer tooling. Stacked, they said "you can talk to this"
— which is table stakes, and not what Phosphor claims. What Phosphor claims is that
**many agents run at once**: lanes, the fleet hub, the orchestrator, fan-out.
None of that was in the mark.

It also died small. At 16px the prompt glyph collapsed into two amber smudges,
so most of the mark's detail was spent on something invisible at the size it is
seen most: tray, favicon, taskbar.

## What replaced it

**The aperture.** A ring of six discrete segments around a phosphor core: one
orchestrator, many agents holding position. The segments are the fleet, the
core is the session you are looking at, and the whole thing reads as a shutter,
a dial and a progress ring at once.

It survives the small sizes the bubble failed. At 32px the segmentation is
still legible; at 16px it reduces to a bright dot inside a broken ring, which
is a recognizable silhouette rather than a smudge.

Chosen from twenty candidates across two families (scanline, bloom). The
runner-up was a four-cursor "swarm" from the scanline family, which said the
same thing more literally but was busier at every size.

## Two things that had to be fixed on the way in

**The ring seam.** `stroke-dasharray` on a circle only looks deliberate if the
pattern divides the circumference a whole number of times. The first attempt
used `126 56` on `r=290`, which is 10.01 periods — close enough to look like a
mistake at the closing point. The shipped pair is computed:
`2π × 258 = 1621.0618 = 6 × (144.17697 + 126)`. Changing the radius or the
segment count means recomputing both numbers, or the seam comes back.

**The bloom banded.** The first version built the glow from two translucent
circles stacked at 0.10 and 0.16. Rasterized, that is not a glow — it is two
hard-edged discs, and the icon read as a bullseye. It is now a
`radialGradient` with three stops falling to zero alpha. Stacked-circle
"glows" should be assumed wrong at raster time; only a gradient actually falls
off.

Both were caught by rendering `build/icon.png` and looking at it, not by
reading the SVG.

## The light twin

`build/icon-light.svg` is the same geometry in ember (`#b35c0f → #9d500b`) on
paper `#f7f7f8`, for light-background documentation. The README carries both
and swaps them with `prefers-color-scheme` inside a `<picture>`.

It is **not** a platform icon. `generate-icons.mjs` reads only `icon.svg`, so
the installed app is always the dark tile on every OS. The light file is hand
maintained; edit both or neither.

Note that the bloom nearly vanishes on paper. That is correct behaviour rather
than a bug: a glow is a thing a dark surface does. The light mark carries its
weight in the ring and core instead.

## What is still owed

The in-app monochrome variant. The style guide has specified one since
2026-08-07 and nothing in `src/` has ever drawn the mark at all — no import of
`icon.svg`, no path, no logo on the About screen. The aperture is built so the
variant is cheap (ring plus core in one `currentColor`, bloom dropped), but it
does not exist yet, and the spec now says so plainly instead of implying it
ships.
