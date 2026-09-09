# Artifacts get a house style, injected at publish time

**2026-09-08.** Until today nothing in this repo styled an artifact. The
`phosphor-artifact://` handler served the model's markup byte for byte, the
viewer set `bg-white` on the iframe, and the tool description asked for
"theme-aware palettes" while naming no colour. So the look of every artifact
was the model's own default — a cream-and-forest-green house style that has
nothing to do with Phosphor — and every artifact paid output tokens to invent
that palette again from scratch.

## What changed

`electron/artifacts/artifact-skeleton.ts` is new. It wraps model markup in a
real document and injects the house stylesheet into its `<head>`:

```
<!doctype html><html lang="en" data-theme="dark"><head>…<style>…</style></head>
<body>  ← the model's fragment
```

Direction A of the approved proposal, "Instrument Deck": near-black ground,
hairline-boxed panels with a corner tick, monospace labels over a sans body,
tabular figures, charts as first-class content. The sheet also ships the
primitives — `.kpis`, `.panelbox`, `table.data`, `.callout`, `.rail`,
`.ledger`, `.steps`, `.blueprint`, `.legend`/`.swatch`/`.grid-line` — so a
model writes `<div class="kpis">` and gets the style for free.

Three properties fall out of injecting rather than prompting:

1. **Zero model tokens.** The palette prose came out of the tool description in
   the same commit.
2. **Retroactive.** The document is rebuilt on every stage, so an artifact from
   last week re-renders in the current style. There is no migration.
3. **Cannot drift.** Two artifacts in one session can no longer disagree about
   what a heading is.

The model's own `<style>` still lands after the sheet in document order, so it
overrides. This is a floor, not a cage.

## Two bugs fixed on the way in

**`data-theme` was never written.** The tool description told the model to
guard its dark rules with `:root[data-theme="dark"]`, and that string appeared
in exactly one place in the whole repo: the prompt itself. Nothing stamped the
attribute on anything. Every dark rule an artifact ever wrote under that
selector was dead code. It is now stamped from the renderer's resolved theme.

**An artifact followed macOS, not Phosphor.** With the attribute dead, the only
live signal was `prefers-color-scheme`, which is Chromium's, which is the OS's —
Phosphor never set `nativeTheme.themeSource`. Phosphor in light mode on a dark
Mac rendered every artifact dark. `main.ts` now sets `themeSource` from the
preference at startup and `app:setTheme` keeps it in step. No feedback loop:
the renderer consults `matchMedia` only while the preference is `system`, which
is exactly the case that leaves `themeSource` at `'system'`.

## The palette is computed, not chosen

Series colours were run through the dataviz six-checks validator on each
surface rather than picked by eye:

| Set                                                         | Result                                                                                          |
| ----------------------------------------------------------- | ----------------------------------------------------------------------------------------------- |
| dark `#c98500 #3987e5 #199e70 #9085e9 #d55181` on `#14120f` | passes adjacent-pair CVD and normal-vision floors                                               |
| the first three of those                                    | also pass all-pairs — hence the three-series cap the prompt puts on scatter and small multiples |
| light `#eda100 #2a78d6 #1baf7a #4a3aa7 #e87ba4` on `#fff`   | passes adjacent, with a contrast relief                                                         |

The light relief is what the required direct labels and evidence tables
satisfy. A sequential amber ramp (`--art-r1..r5`) passes the ordinal checks —
monotone lightness, visible step gaps, light end clear of the surface.

Dark sits on bare `:root` here and light is the override, which inverts the
usual advice on purpose: this surface is dark by design.

## Sharp edges

- **`--art-*`, never `--px-*`.** A `--px-` token in that sheet would make it a
  sixth satellite copy of the app neutrals (see
  [style-guide.md](../style-guide.md)) and bind two surfaces that want
  different contrast. A test asserts the namespace stays out.
- **`stageArtifactHtml` hashes the finished document, not the markup.** That is
  what makes a theme switch reach an open artifact: same markup, different
  theme, different URL, so the iframe reloads. Hashing the markup would leave
  the old theme on screen until the artifact itself changed.
- **`artifacts:stageHtml` takes the theme as an argument** rather than reading
  prefs in the main process. The renderer needs it as an effect dependency;
  without one, `SandboxedHtml` would never re-stage.
- **A model that ignores the fragment rule still renders.** A full document
  gets the sheet injected into the head it already has and its root tag
  re-stamped, rather than being nested inside a second `<html>`.
- **The browser harness shows artifacts unstyled.** `mockPhosphor` has no main
  process to inject from. That is a real difference between the two harnesses,
  not a mock to fill in.
