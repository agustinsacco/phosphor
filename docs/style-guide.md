# Phosphor visual identity

> **This file is the authority on Phosphor's visual identity.** The design
> system was named "Phosphor" first (2026-08-07); on 2026-09-08 the app took
> the design system's name. Where any other
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
7. **The logo's faint parts must stay faint and its bright parts bright.**
   The shells are decoration and may vanish when small; the nucleus, orbit and
   head are the mark. Two identities died by putting the concept in the faint
   layer, where it composites to 1.18:1 and is simply not there at 32px.
8. **The logo's geometry lives in `BEACON`**
   (`src/components/PhosphorMark.tsx`), not in CSS and not in the SVG — a CSS
   `stroke-width` beats a presentation attribute and silently wins.
   `PhosphorMark.test.ts` fails when `build/icon.svg` drifts from it.
9. **The logo's bloom must stay a `radialGradient`.** Stacked translucent
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

**Artifacts are their own surface, for the same reason.**
`electron/artifacts/artifact-skeleton.ts` carries a `--art-*` namespace —
darker ground than the app (`#0e0d0b` vs `--px-bg`), denser type, and a
categorical data palette app chrome has no use for. It is not a satellite copy
and must never be "unified" with the neutrals: an artifact is a document, the
app is chrome, and the two want different contrast. Its series colours are
computed rather than chosen (the dataviz six-checks validator, both modes) —
re-run it before changing a hex. The sheet is **injected** into every staged
document's `<head>`, never prompted for — which is why it costs no model tokens,
applies retroactively to artifacts written weeks ago, and cannot drift between
two artifacts in one session.

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
the app shell mounts, so Monaco/xterm never cache metrics before a later bundled-font
swap. The startup screen remains visible while fonts settle.
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

**Session chrome:** sidebar titles use `text-lg` on a single truncated line —
a narrow sidebar must not re-flow the list — with the full name in the tooltip; their
metadata uses `text-base` with secondary ink (primary on the selected row).
Composer actions have 32px square targets and the composer stays two rows —
field and footer — with formatting on the keyboard rather than a toolbar strip.
The model chip is **one line**: the name in `text-lg`, then the provider in
mono `text-sm` tertiary beside it, shown only when the provider is not one pi
ships itself. Both truncate, and the provider gives up its width first — the
name answers the question, the provider only disambiguates two same-named
models. The tooltip carries both in full. Pane-header controls wrap together at
narrow widths.
Placeholders and Changes labels use readable ink. These are scoped role
migrations, not changes to the global scale or saved body-font preferences.

**Mono:** JetBrains Mono (user-configurable), and the **structural voice**, not
a code-only font. Section labels, workspace group headers, badges, stat-tile
labels and eyebrows are mono, 10–11px, uppercase, `letter-spacing: .06–.09em`,
`--px-text-tertiary`. This is the single biggest non-color differentiator from
Claude.

**Serif:** not part of the brand voice. `--px-font-serif` stays defined for
markdown the _model_ authors; no Phosphor chrome uses it.

## Shape, depth, motion

- Radii: 6 / 10 / 14 (`--px-radius-sm` / `--px-radius` / `--px-radius-lg`).
  Floating IDE panes use `rounded-md` (6px), without a card shadow; their
  tabs and icon controls use `rounded-sm` (2px). A compact, bordered header
  separates tools from content. Chat bubbles and dialogs keep their own shape.
- Depth comes from borders and one-step background shifts. No drop shadow
  heavier than `0 1px 2px rgb(0 0 0 / 0.06)` in light; popovers excepted.
- Motion: message-in 180ms, expand-in 140ms, beacon, shimmer. All token-driven
  and all gated on `prefers-reduced-motion`. The streaming cursor `▍` and the
  working beacon inherit phosphor automatically.

### Loading identity — Phosphor Beacon

`src/components/PhosphorLoader.tsx` is the shared **indeterminate activity**
mark for app startup, starting/working lanes, and agent activity in chat. It
replaces the eight-ray PiSpark everywhere; generic file/network button spinners
remain generic. As of 2026-09-09 it is **also the logo** — same glyph, orbit
turning instead of at rest — so it draws `BeaconGlyph` from
`components/PhosphorMark.tsx` rather than its own paths. See §Logo.

- **Form:** a persistent nucleus, two quiet rings, one bright orbiting head
  and its short trail. The whole mark never fades away. The radial accent-soft
  bloom is CSS, not stacked discs or an SVG blur filter.
- **Scale:** 20px in the lane gutter (previously a 13px spark), 24px beside
  activity copy, 80px on the startup screen. All use the same SVG geometry.
- **Motion:** one 2.4s linear orbit; the nucleus breathes between 75–100%
  opacity and 85–100% scale. `--px-beacon-duration` owns the shared cadence.
  Only transform/opacity animate: no per-frame JavaScript or layout work.
- **State:** Starting means a prompt is sent but the agent has not started;
  Working follows the existing streaming state, including tool activity.
  Idle/completed lanes lose the beacon, label and rail; green unread/live
  dots retain their existing meaning. Selection remains the neutral row fill.
- **Lane recipe:** beacon + straight, inset 2px amber rail + Starting/Working
  chip in the timestamp slot. The chip uses primary text on accent-soft, not
  tiny amber text. The former timestamp remains in its tooltip. At narrow row
  widths, dirty count (≤256px) then the worktree chip (≤224px) yield to the
  activity label, branch and PR. Both pending and disk-backed rows use this
  treatment, including unselected/background lanes. The hover checkbox keeps
  the same 20px gutter; label and rail remain visible when it replaces the icon.
- **One beacon per turn.** The strip above the composer reports the PROCESS
  (beacon, elapsed timer, token count, `Esc to stop`); the transcript only
  holds a SEAT for the content — the same blinking `.streaming-cursor` the
  streaming tail paints, so prose grows from where the caret sat. An empty
  streaming turn must never render a second beacon in the message list: two
  identical orbiting marks for one turn read as two things loading. Same rule
  as a running tool, whose label shimmers instead of adding a circle.
- **Accessibility:** pair the mark with readable status text; set `decorative`
  when that text already names the state. Standalone marks receive a label.
  No fake percentage or per-lane live-announcement loop. Reduced motion stops
  both orbit and breathing but retains every visual cue; errors use
  `animated={false}` rather than displaying a moving loader forever.

A larger spark alone still competed with lane emoji; a full-row shimmer would
make a busy sidebar a wall of motion. The beacon plus static rail and text
makes work visible without either problem.

## Logo

The **beacon**: a steady nucleus, two faint shells and one orbiting signal.
Amber (`#f2ab4e → #e2922e`) on graphite `#1f1c18`, tile radius 228/1024. No
letterform and no text — "Phosphor" is set separately, capitalized, in the
mono face.

**The mark and the working indicator are one object.** That is the whole
point of it: the app has always drawn a beacon while an agent runs, and it
survives at 20px in a lane, which no previous mark managed at 32px. Every
surface renders the same glyph and none of them owns a second copy:

| Surface         | File                                            | State           |
| --------------- | ----------------------------------------------- | --------------- |
| Geometry        | `BEACON` in `src/components/PhosphorMark.tsx`   | source of truth |
| App icon        | `build/icon.svg` — `BEACON` × `ICON_SCALE` (28) | at rest         |
| In-app identity | `<PhosphorMark>` / `<PhosphorLockup>`           | at rest         |
| In-app activity | `<PhosphorLoader>`                              | orbit turning   |
| Website + tab   | `site/public/favicon.svg` — generated           | at rest         |

`src/components/PhosphorMark.test.ts` reads `build/icon.svg` back and fails if
it drifts from `BEACON`; it also asserts the favicon is byte-identical to the
icon and that `site/src/layouts/Page.astro` points an `<img>` at it rather than
inlining an `<svg>` of its own. It exists because the mark before this one
shipped as two different drawings — the app icon had bare shells, the website
added animated electrons — and nothing compared them.

- **App icon:** always the full tile. Dark on every OS.
- **Light backgrounds:** `build/icon-light.svg` — same geometry, ember
  (`#b35c0f → #9d500b`) on paper `#f7f7f8`, shell opacities bumped (.35→.5,
  .2→.34) because a translucent line loses more contrast on paper than on
  graphite. Documentation only; the README swaps the two on
  `prefers-color-scheme`. Hand-kept: edit both or neither.
- **Clear space:** the nucleus's diameter (`3/32` of the mark's width) on all
  sides of the mark's bounding box.
- **Small sizes:** the shells go first, then the inner shell entirely. That is
  the design, not a rendering bug — see the contrast rule below.
- Regenerate platform assets with `node scripts/generate-icons.mjs`
  (Playwright-rendered; icns is darwin-only). It reads only `icon.svg`, and
  also writes `site/public/favicon.svg`.

**The contrast hierarchy is the mark.** The shells sit at `.35` and `.2` and
are _allowed_ to disappear when small, because the nucleus, the orbit and its
head are full-strength and carry the mark alone. Inverting that is what broke
the previous two identities: their concept lived in `.10` rings and a 64px
caption, which composite to 1.18:1 and 2px in a 32px tile, so what shipped was
never what was designed. If you add an element, decide which side of that line
it is on before you pick its opacity.

Geometry lives in `BEACON`, not in `index.css` and not in the SVG. A CSS
`stroke-width` beats a presentation attribute, so putting one back in the
stylesheet silently overrides the component. The scale factor is 28 because
every value stays a whole number at 1024 (11/6/3, stroke 1.5/1, orbit 2.5 →
308/168/84, stroke 42/28, orbit 70). The mark keeps its own graphite
`#1f1c18`, which is not `--px-bg` in either theme — it is a fixed brand asset,
not a themed surface. Don't token-ize it.

## Voice

Capitalized "Phosphor" always — it is a proper noun. The dark
accent color keeps its lowercase "phosphor" when named as a color, not as the
product. Labels are verbs or nouns,
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

Why the current state is the current state.

| Date       | Change                                                                                                                            |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------- |
| 2026-08-07 | Phosphor replaced the Claude-study palette.                                                                                       |
| 2026-08-10 | Light neutrals re-based warm → cool (`11a5d7c`), bundled in a QoL pass with no design note.                                       |
| 2026-08-29 | Doc reconciled with the code; 11 light tokens corrected, four satellites re-neutralized.                                          |
| 2026-08-29 | Aperture mark replaced the prompt bubble.                                                                                         |
| 2026-09-08 | The app took the name of its design system. Capital P always; the previous lowercase-brand voice rule retired with the old name.  |
| 2026-09-08 | Electron-shell mark replaced the aperture, chosen from 30 explorations.                                                           |
| 2026-09-09 | The beacon replaced the electron shell — the working indicator promoted to the identity, after a review of what actually renders. |
