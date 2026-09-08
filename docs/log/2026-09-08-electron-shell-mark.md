# The electron-shell mark

The aperture (2026-08-29) is retired. The new mark is **Element 15**: a drawn
"P" inside phosphorus's three electron shells, the configuration `2 · 8 · 5`
beneath in the mono face. Chosen the same day the app took the Phosphor name —
the aperture said "one orchestrator, many agents"; the new mark says the name
itself.

## How it was chosen

Three exploration rounds, 30 candidates total, all preserved as sanctioned
variations in [brand-explorations.md](../brand-explorations.md) with their
SVGs in `docs/img/brand/`:

1. **Ten directions** (match, strike, flame, ember ring, element 15, scanline
   flame, wick, spark, flame-in-aperture, ignition).
2. **Ten flame descendants** — the flame direction pushed through silhouette,
   symmetry, core treatment and framing.
3. **Ten Element-15 descendants** — the periodic-cell direction pushed through
   frame weight, counter treatment and how much chemistry the mark admits.
   **#10, Electron Shell, won.**

## What changed on disk

- `build/icon.svg` — the new mark, with its load-bearing comments (shell
  geometry is chemistry; bloom stays a radialGradient; the P is a path, not a
  font glyph; center is (512, 470), not the canvas center).
- `build/icon-light.svg` — ember-on-paper twin, shell opacities bumped for
  paper.
- All platform binaries regenerated via `node scripts/generate-icons.mjs`
  (icon.png, icons/, icon.icns, icon.ico, icon-dock.png).
- `docs/style-guide.md` §Logo rewritten; breaking-rule #7 (the aperture's
  dash-pattern rule) replaced with the shell-geometry rule.
- `docs/brand-explorations.md` + `docs/img/brand/*.svg` (30 files) added.

## What deliberately did not change

- The tile: graphite `#1f1c18`, radius 228/1024, amber gradient, radial bloom.
  Every candidate in all three rounds kept this DNA, so the dock silhouette
  and TCC-visible identity are continuous.
- The in-app monochrome variant is still **not built** — no component in
  `src/` draws the mark. Third mark to carry this line; it is a real gap, not
  a convention.

## Known trade-offs

- The caption is the mark's only font-dependent element (`ui-monospace` stack
  with explicit fallbacks). GitHub, browsers and the Playwright rasterizer all
  resolve it; a renderer with no mono font at all would fall back to its
  default monospace, which is acceptable drift for a 64px caption.
- Below ~48px the shells fade out and the caption reads as a baseline
  texture; the P carries the mark alone. Verified against the generated 32px
  and 16px PNGs — expected, documented in the style guide.
