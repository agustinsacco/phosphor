# Phosphor refinement

**Visual/UX proposal, not shipped behavior.** Companion to the
[engineering workbench review](ai-workbench-review-2026-09-05.md), assessed
2026-09-05. This assessment remains docs-only; the approved subset is implemented
in the [#194–#199 stack](session-polish-pr-2026-09-05.md#implementation-and-evidence),
awaiting merge. The rest remains a proposal.

## Direction

**A calm, precise editor with a little instrument-panel character.** Keep warm
Phosphor dark and cool-neutral light; improve hierarchy rather than rebrand.
The task and the response should dominate. Branches, routing, costs and process
metadata should support them, not become equally prominent pills.

This deliberately proposes fewer tiny mono labels and more readable defaults.
It does not supersede the current [style guide](../../style-guide.md). Adopted
changes must update that guide and the relevant implementation together.

## Typography

**Keep Inter for UI/prose and JetBrains Mono for code.** A fashionable font swap
would do less than reliable font delivery, stronger ink and clear role assignment.
Use sans weights 400 for reading, 500 for controls, 600 for headings; avoid heavy
headings and negative tracking in small UI copy. Retain mono for paths, code and
occasional structural labels, not every badge or button. Use tabular numbers for
costs/counters; make code ligatures optional, off by default for diffs.

The current [CSS](../../../src/styles/index.css) declares both faces, but a repo
search found no bundled UI font files, `@font-face`, font-CDN links or font-loading
dependency. [Appearance](../../../src/features/settings/tabs/AppearanceTab.tsx)
offers named mono fonts without checking availability. Installed fonts can render;
otherwise the declared stack falls back. This is not a measurement of the font
actually rendered on each user's machine. KaTeX's dependency fonts are unrelated.

Bundle the selected families locally with their license notices; retain system
and script fallbacks. Do not introduce a runtime CDN dependency or require users
to install the advertised default font. Validate actual rendered glyph sources,
not only the CSS family string. See [Inter](https://github.com/rsms/inter#readme)
and [JetBrains Mono](https://www.jetbrains.com/lp/mono/) for official font sources
and SIL Open Font License terms.

| Role                          | Proposed default at 100% zoom    |
| ----------------------------- | -------------------------------- |
| Controls / navigation         | 13–14 px, medium where needed    |
| Conversation                  | 15.5–16 px, line-height 1.6–1.65 |
| Code / terminal               | 13–14 px, user adjustable        |
| Meaningful metadata           | 12–13 px, secondary ink          |
| Lane title                    | 18–20 px, semibold               |
| Occasional structural eyebrow | 11–12 px mono, secondary ink     |

Current named steps include 9 px badges, 10.5 px chips and 12.5 px controls;
chat defaults to 14.5 px. Migrate by role, not a global alias replacement. Preserve
existing user font choices and page zoom. Add Comfortable / Compact spacing
separately: compact changes padding/row height, not legibility or font size.

## UI rules

- **Three clear surface roles per view:** recessed navigation, a reading plane,
  raised interaction/overlay. Keep existing palette tokens; reduce redundant nested
  borders and cards rather than invent more backgrounds. Keep the 6/10/14 px radius
  family and restrained depth; no glass, neon gradients or oversized in-app heroes.
- **One dominant title and next action.** Let long lane titles use two lines before
  truncating. Use one useful status per row; move branch/cost/routing to secondary
  details. Keep personalization optional and status independent of emoji.
- **Readable, not washed out.** Essential status uses secondary or primary ink.
  Existing tertiary/page contrast is 2.74:1 light and 3.77:1 dark, below normal-text
  4.5:1. Color and animation must never be the only status signal.
- **4 px spacing rhythm:** 8 within groups, 16 between related blocks, 24 between
  sections. Aim for 32–36 px desktop controls. Keep meaningful targets usable in
  Compact. Normalize existing icons to consistent optical size/stroke before
  considering another icon pack.
- **Reading width before column count.** Prose around 65–75 characters where space
  allows; code gets its own horizontal scroll. At 1000 px or high zoom, remove a
  column before shrinking text. Hidden navigation must remain explicitly reachable.

## UX and feel

- **Home:** prompt, provider readiness and exact checkout destination together;
  optional starters, not a compulsory wizard or a large empty greeting.
- **Sidebar:** attention before chronology, with a stable selection and details on
  demand. Do not reorder a row under the pointer during a click.
- **Composer:** prompt first; model/account/effort/context second. Keep the actual
  destination and routing legible without wrapping them in a wall of chips.
- **Panes:** labeled destinations at comfortable widths; Focus / Review / Debug
  layouts rather than permanently squeezing chat, tree, editor and terminal together.
- **Settings:** live type sample, honest font availability and density separate from
  zoom. Make font-size changes apply predictably to already-open views as well.
- **Activity:** refine existing grouping and pane memory. Keep scroll, selection and
  user-expanded details stable; don't auto-switch views when work finishes.
- **Motion:** one subdued working indicator; roughly 120–180 ms local feedback.
  No repeated entrance animation for streaming text; honor reduced motion. More
  simultaneous shimmer is not more useful feedback.
- **Failure and keyboard:** retain partial work; show reason and recovery beside it,
  not only in a toast. Use semantic controls, visible focus, keyboard activation,
  modal focus containment/restoration and meaningful empty/loading/error states.

## First implementation slices and verification

For the bounded next PR, see [Readable sessions and diffs](session-polish-pr-2026-09-05.md).

1. Bundle/verify fonts, correct important low-contrast copy, migrate typography by
   role. Check fallback scripts, glyph ambiguity, offline startup and license files.
2. Polish sidebar → conversation → composer → Changes as one coherent slice.
   Inspect light/dark at laptop width and 100%/125%/150% zoom, long titles, large
   diffs, empty/loading/error states, keyboard-only operation and reduced motion.
3. Extend the shared controls/density rules to Settings, terminal and artifacts.
   Preserve independent editor/terminal font preferences; check Windows/Linux font
   rendering and screen readers before claiming cross-platform accessibility.

The private **Phosphor Refined** artifact illustrates this direction using sample
content and system font fallbacks; it is not an exact Inter/JetBrains glyph specimen
or a working app. Existing screenshots/prior macOS inspection ground the critique.
The companion was rendered at 1400/1000/390 px in both themes: no document overflow;
keyboard tabs/focus, density, draft/view retention, reduced motion and the sample
loading/error/empty states passed browser checks. Secondary/page text measured
5.31:1 light and 6.89:1 dark. These are scoped checks, not an accessibility audit.
No user study establishes that the proposed sizes or layout improve speed/fatigue.
