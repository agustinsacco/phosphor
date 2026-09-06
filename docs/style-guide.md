# pidex visual identity — "Phosphor"

> **This file is the authority on pidex's visual identity.** Where any other
> spec disagrees, this one wins. `src/styles/index.css` carries these values;
> the five satellite copies below mirror them by hand.

Dark is warm all the way down: graphite neutrals under an amber **phosphor**
accent, the color of the CRT terminals this category descends from. Light is
the opposite — cool neutral greys under an **ember** accent, so the amber is
the only warm thing on the page. The two themes are not mirror images, and that
is deliberate.

Inherited from the Claude Desktop study: soft surfaces and generous
line-height. Dropped from it: terracotta, warm cream neutrals, the serif voice.
Taken from Codex: high-contrast ink, deep darks, and monospace as a structural
voice rather than a code-only font.

## Rules that break things

Not obvious from reading the code. Each has been violated at least once.

1. **A neutral cannot be changed in one place.** `index.css` plus the five
   satellite copies. Nothing compile-time-checks it — grep the old hex across
   all six files or light mode silently splits.
2. **Never `text-white` on `bg-accent`.** Amber is a _light_ color. Use the
   pair `bg-accent text-accent-text`, which flips to near-black ink in dark.
3. **Never `text-[Npx]`.** Use one of the nine named steps.
4. **Components never hardcode hex.** Only `MermaidBlock.tsx` and
   `ChartBlock.tsx` may, because they take theme objects rather than CSS.
5. **Window chrome must equal `--px-bg`** in both themes. It is set before any
   CSS loads, so it can only be a literal — the two agreeing _is_ the contract.
6. **Light neutrals stay cool.** Warming them without re-picking the accent is
   a change that has already been made and reverted.
7. **The logo's dash pattern is computed, not chosen.** Recompute it if the
   radius or segment count changes, or the ring gets a visible seam.
8. **The logo's bloom must stay a `radialGradient`.** Stacked translucent
   circles rasterize into hard-edged discs and read as a bullseye.

## Color

Tokens are the `--px-*` custom properties in `src/styles/index.css`, mapped to
Tailwind via `@theme inline`.

Five surfaces take a theme **object** rather than CSS, so each carries a
mirrored copy that must be updated in the same commit:

| Surface       | Themed copy in                                  |
| ------------- | ----------------------------------------------- |
| xterm         | `src/features/terminal/xtermTheme.ts`           |
| Monaco        | `src/lib/monaco.ts`                             |
| Mermaid       | `src/components/markdown/MermaidBlock.tsx`      |
| Chart.js      | `src/components/markdown/ChartBlock.tsx`        |
| Window chrome | `electron/window-chrome.ts`, `electron/main.ts` |

**Syntax highlighting is deliberately off-palette.** Shiki runs the stock
`vitesse-light` / `vitesse-dark` pair (`src/components/markdown/highlighter.ts`)
and holds no `--px-*` values, so it is not a sixth satellite. Code-block token
colors are not expected to match the brand ramp.

### Light — "slate paper"

Cool neutral greys. The accent is the only warm element on the page.

| Token                 | Value                 | Notes                                    |
| --------------------- | --------------------- | ---------------------------------------- |
| `--px-bg`             | `#f7f7f8`             | paper — equals the window-chrome literal |
| `--px-bg-secondary`   | `#efeff1`             |                                          |
| `--px-sidebar`        | `#ededef`             | sidebar recedes below the page           |
| `--px-sidebar-hover`  | `#e6e6ea`             |                                          |
| `--px-sidebar-active` | `#dedee3`             |                                          |
| `--px-surface`        | `#ffffff`             | cards, editors, terminal                 |
| `--px-surface-raised` | `#ffffff`             |                                          |
| `--px-chip`           | `rgb(38 38 42 / .09)` | alpha — rides any surface                |
| `--px-border`         | `#e4e4e7`             |                                          |
| `--px-border-strong`  | `#c9c9ce`             |                                          |
| `--px-border-focus`   | `#d6d6db`             | composer focus: one step, not a jump     |
| `--px-text`           | `#26262a`             | 14.1:1 on bg                             |
| `--px-text-secondary` | `#66666e`             | 5.3:1                                    |
| `--px-text-tertiary`  | `#96969e`             | meta/decorative only                     |
| `--px-accent`         | `#b35c0f`             | **ember** — 4.4:1 on bg, 4.7:1 on white  |
| `--px-accent-hover`   | `#9d500b`             |                                          |
| `--px-accent-soft`    | `#f6e9d4`             | selections, hover washes — stays warm    |
| `--px-accent-text`    | `#ffffff`             | 4.7:1 on accent                          |
| `--px-success`        | `#4c8a54`             | live-session dots, diff adds             |
| `--px-warning`        | `#a8842e`             |                                          |
| `--px-danger`         | `#bb4a3c`             | 4.7:1 on bg                              |
| `--px-danger-soft`    | `#f8e8e4`             |                                          |
| `--px-merged`         | `#7c5cbf`             | merged PRs — deliberately not success    |
| `--px-merged-soft`    | `#efe9fa`             |                                          |
| `--px-info`           | `#47708f`             |                                          |
| `--px-user-bubble`    | `#eeeef1`             |                                          |
| `--px-code-bg`        | `#f2f2f4`             |                                          |
| `--px-terminal-bg`    | `#ffffff`             |                                          |
| `--px-scrollbar`      | `#c9c9ce`             |                                          |

### Dark — "phosphor"

| Token                 | Value                    | Notes                                 |
| --------------------- | ------------------------ | ------------------------------------- |
| `--px-bg`             | `#1e1c18`                | warm graphite                         |
| `--px-bg-secondary`   | `#26231e`                |                                       |
| `--px-sidebar`        | `#15130f`                | **darker than `--px-bg`** — recedes   |
| `--px-sidebar-hover`  | `#221f19`                |                                       |
| `--px-sidebar-active` | `#2d2921`                |                                       |
| `--px-surface`        | `#2a2721`                |                                       |
| `--px-surface-raised` | `#322e27`                |                                       |
| `--px-chip`           | `rgb(236 231 219 / .11)` | alpha — rides any surface             |
| `--px-border`         | `#3a352c`                |                                       |
| `--px-border-strong`  | `#4b453a`                |                                       |
| `--px-border-focus`   | `#453f34`                |                                       |
| `--px-text`           | `#ece7db`                | 13.8:1 on bg                          |
| `--px-text-secondary` | `#aca496`                | 6.9:1                                 |
| `--px-text-tertiary`  | `#7c766a`                |                                       |
| `--px-accent`         | `#eca03d`                | **phosphor** — 7.8:1 on bg            |
| `--px-accent-hover`   | `#f2b158`                |                                       |
| `--px-accent-soft`    | `#3d3220`                |                                       |
| `--px-accent-text`    | `#241503`                | dark ink on amber — 8.2:1             |
| `--px-success`        | `#7fbe88`                | 7.8:1                                 |
| `--px-warning`        | `#d8ab52`                |                                       |
| `--px-danger`         | `#dd7663`                | 5.6:1                                 |
| `--px-danger-soft`    | `#46302a`                |                                       |
| `--px-merged`         | `#a98ce0`                | merged PRs — deliberately not success |
| `--px-merged-soft`    | `#2f2740`                |                                       |
| `--px-info`           | `#82a9c9`                |                                       |
| `--px-user-bubble`    | `#2f2b24`                |                                       |
| `--px-code-bg`        | `#24211c`                |                                       |
| `--px-terminal-bg`    | `#1e1c18`                | the page itself, not a raised surface |
| `--px-scrollbar`      | `#4b453a`                |                                       |

### How the palette is built

- **Neutrals cool, meaning warm.** The semantic ramp (accent, success, warning,
  danger, info) and `--px-accent-soft` are warm in both themes. Only the
  neutrals differ between light and dark in character.
- **`--px-merged` is the one hue outside that story.** "Merged" and "open and
  green" are the two states the sidebar is scanned to tell apart, so rendering
  both in `--px-success` hides the one meaning _this lane is done_. Violet was
  the only hue unspoken for. A sixth semantic color needs that kind of reason.
- **`bg-danger` + `text-white` is a standing exception** (`src/components/form.tsx`),
  3.1:1 in dark and below AA. Accepted because danger buttons are short, bold,
  and never the only signal. Don't copy it; don't "fix" it without changing
  `--px-danger` itself.

### Terminal (xterm ANSI)

The terminal is the brand's home turf: in dark it sits on `--px-bg` itself, not
a raised surface, cursor in phosphor. Light stays `#ffffff` with the ember
cursor. Full 16-color ramps live in `xtermTheme.ts`, derived from the tables
above (red→danger, green→success, yellow→warning, blue→info, magenta/cyan
warmed to match). Its neutrals — `foreground`, `black`, `white`, `brightBlack`,
`brightWhite` — track the cool light ramp, not the warm ANSI convention.

Dark `selectionBackground` is `#8a6a2f66`, deliberately not `--px-accent-soft`
with alpha: the old value blended to within a few points of `--px-bg`, so a
drag looked like nothing had been selected.

## Typography

**UI:** Inter / system sans. Body 14px/1.55.

Inter and JetBrains Mono (variable normal/italic faces) are bundled locally;
[pinned sources and checksums](../src/assets/fonts/README.md). Settings → About
includes both licenses. `src/lib/fonts.ts` loads and registers settled faces before
React mounts, so Monaco/xterm never cache metrics before a later bundled-font swap.
Startup waits at most 1.5 seconds: failed/late faces stay on system fallbacks for
that launch. No CDN, font installation requirement, or preference reset.

**Scale:** nine steps in `@theme`. Every step pins its line-height to `inherit`
rather than carrying Tailwind's default; set leading explicitly with `leading-*`
where a block needs its own.

| Utility     | Size   | For                                            |
| ----------- | ------ | ---------------------------------------------- |
| `text-2xs`  | 9px    | dense badges, in-context pills                 |
| `text-xs`   | 10.5px | uppercase mono eyebrows, group headers, chips  |
| `text-sm`   | 11.5px | tertiary metadata: timestamps, paths, counts   |
| `text-base` | 12.5px | the workhorse — controls, list rows, secondary |
| `text-lg`   | 13.5px | primary UI copy, header and menu titles        |
| `text-xl`   | 16px   | stat values, settings section headings         |
| `text-2xl`  | 20px   | empty-state headline                           |
| `text-3xl`  | 24px   | setup screen headline                          |
| `text-4xl`  | 28px   | home / picker hero headline                    |

Chat, editor and terminal body text are **not** on this scale — they are
user-configurable (`--px-chat-font-size` and friends, Settings → Appearance).
Overall size is page zoom, not a font-size multiplier; see
`electron/window-chrome.ts`.

**Mono:** JetBrains Mono (user-configurable), and the **structural voice**, not
a code-only font. Section labels, workspace group headers, badges, stat-tile
labels and eyebrows are mono, 10–11px, uppercase, `letter-spacing: .06–.09em`,
`--px-text-tertiary`. This is the single biggest non-color differentiator from
Claude.

**Serif:** not part of the brand voice. `--px-font-serif` stays defined for
markdown the _model_ authors; no pidex chrome uses it.

## Shape, depth, motion

- Radii: 6 / 10 / 14 (`--px-radius-sm` / `--px-radius` / `--px-radius-lg`).
  Floating IDE panes use `rounded-md` (6px), without a card shadow; their
  tabs and icon controls use `rounded-sm` (2px). A compact, bordered header
  separates tools from content. Chat bubbles and dialogs keep their own shape.
- Depth comes from borders and one-step background shifts. No drop shadow
  heavier than `0 1px 2px rgb(0 0 0 / 0.06)` in light; popovers excepted.
- Motion: message-in 180ms, expand-in 140ms, spark, shimmer. All token-driven
  and all gated on `prefers-reduced-motion`. The streaming cursor `▍` and the
  working spark inherit phosphor automatically.

## Logo

`build/icon.svg` — the **aperture**: a ring of six discrete segments around a
phosphor core. One orchestrator, many agents holding position. Core and ring in
amber (`#f2ab4e → #e2922e` vertical), tile in graphite `#1f1c18`, tile radius
228/1024.

- **App icon:** always the full tile. Dark on every OS.
- **Light backgrounds:** `build/icon-light.svg` — same geometry, ember
  (`#b35c0f → #9d500b`) on paper `#f7f7f8`. Documentation only; the README
  swaps the two on `prefers-color-scheme`. Hand-kept: edit both or neither.
- **In-app / monochrome:** ring plus core in one `currentColor`, bloom dropped.
  **Not built** — no component in `src/` draws the mark at all. The previous
  mark carried this same line unbuilt for three weeks; don't repeat that.
- **Clear space:** half the ring's diameter on all sides. No text in the mark;
  "pidex" is set separately, lowercase, in the mono face.
- Regenerate platform assets with `node scripts/generate-icons.mjs`
  (Playwright-rendered; icns is darwin-only). It reads only `icon.svg`.

The dash pattern divides the circumference exactly six times
(`2π × 258 = 1621.0618 = 6 × (144.17697 + 126)`). The mark keeps its own
graphite `#1f1c18`, which is not `--px-bg` in either theme — it is a fixed
brand asset, not a themed surface. Don't token-ize it.

## Voice

Lowercase "pidex" always, including sentence starts. Labels are verbs or nouns,
never sentences: "Export HTML…", not "Click here to export". Qualifiers ride as
muted hints, never parentheticals.

## Don't

- Don't reintroduce terracotta (`#c96442` / `#d97757`).
- Don't use the accent for large fills. It is for interaction, focus and the
  working-state glow; backgrounds stay neutral.
- Don't set amber text on paper below 14px bold.
- Don't mix the pre-Phosphor and Phosphor palettes in one surface. Change a
  surface atomically or not at all.

## History

Why the current state is the current state. Details in the linked write-ups.

| Date       | Change                                                                                                                                         |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-07 | Phosphor replaced the Claude-study palette.                                                                                                    |
| 2026-08-10 | Light neutrals re-based warm → cool (`11a5d7c`), bundled in a QoL pass with no design note.                                                    |
| 2026-08-29 | [Doc reconciled with the code](log/2026-08-29-phosphor-light-palette-reconcile.md); 11 light tokens corrected, four satellites re-neutralized. |
| 2026-08-29 | [Aperture mark](log/2026-08-29-aperture-mark.md) replaced the prompt bubble.                                                                   |
