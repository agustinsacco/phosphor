# Artifact tables and row grids survive a narrow panel

**2026-09-09.** The house style landed a day ago and the look is right. What is
not right is anything shaped like a table. A real review artifact — a six-column
capability matrix plus three `.ledger` rows of prose — rendered with the page
scrolling sideways and whole paragraphs stacked one word per line, in a column
about 30px wide.

Two separate faults, both in the "row of cells" family.

## A `.ledger` row of prose was laid out as four columns

`.ledger .row` was an unguarded `grid-template-columns:1.6rem 1fr 4.5rem 4rem`.
A grid container makes **one grid item per child** — including anonymous items
for the loose text between inline elements. So this:

```html
<div class="row">
  <strong>Eight identical rows.</strong> <span class="mono">SubagentBlock</span> has no …
</div>
```

is not one cell of prose. It is `<strong>` in the 1.6rem track, a text run in
`1fr`, a `<span>` in 4.5rem, another text run in 4rem, and everything left over
wrapped into implicit rows below. Measured on the artifact that prompted this:
one prose row 469px tall at a 380px viewport. `.steps .s` (two tracks) and
`.rail .node` had the same hazard.

The track is now behind a `:has()` guard on the cells the primitive actually
defines, so a data row keeps its grid and a prose row degrades to a paragraph
(in the sans face, since it is prose):

```css
.ledger .row:has(>.idx,>.lab,>.bar,>.val){display:grid;grid-template-columns:1.6rem 1fr 4.5rem 4rem;…}
.ledger .row:not(:has(>.idx,>.lab,>.bar,>.val)){font-family:var(--art-sans);…}
.steps .s:has(>.n){display:grid;…}
.rail .node:has(>.gut){display:grid;…}
```

A test walks the sheet and fails any `.ledger`/`.steps`/`.rail` rule that sets
`grid-template-columns` without a `:has()` in its selector.

## `table.data` demanded 30rem it did not have

`min-width:30rem` is 480px. The artifact panel is routinely narrower — 380px is
ordinary — so the table pushed the document into a horizontal scroll, which the
prompt explicitly forbids. It is now `min-width:min(100%,30rem)`: it asks for
30rem only while there is 30rem to ask for. Cells wrap (`overflow-wrap:anywhere`)
instead of overflowing, `td.num` and `.pill` stay unbroken, and `.scroll` gained
`max-width:100%` so an explicit wrapper actually contains its child.

Measured on the same fragment at a 380px viewport, before → after:

| Check                | Before             | After           |
| -------------------- | ------------------ | --------------- |
| page `scrollWidth`   | 524 (vs 380 inner) | 380 — no scroll |
| prose `.ledger .row` | `grid`, 469px tall | `block`, 144px  |
| data `.ledger .row`  | `grid`, 4 tracks   | unchanged       |
| `table.data` width   | 508 (overflowing)  | 348 (fits)      |

At 900px the old sheet still overflowed (952) — the prose-row grid, not the
table, was doing that on its own.

## The instructions carry what CSS cannot

The stylesheet is a floor, not a fix for a table that should never have had six
columns of yes/no pills. `pi-ext/artifacts.ts` now tells the model, in the
`artifact_create` description and in `promptGuidelines`:

- five columns maximum, because the reading panel is often ~380px wide; label
  first, numbers right in `td.num`;
- a cell holds a value or a short phrase — a sentence belongs in the paragraph
  above the table;
- a broad matrix of yes/no marks is a chart, a `.kpis` strip or a list, not a
  table;
- a table that genuinely needs more width goes in `<div class="scroll">`;
- **the row primitives are column grids, not paragraph styles** — prose goes in
  `<p>`, a list, or a `.callout`.

Nothing else about the house style changed.

## Sharp edge

The sheet is a JS template literal in `electron/artifacts/artifact-skeleton.ts`.
A backtick in a CSS comment there — quoting a property value, say — is a syntax
error in the module, not a CSS quirk. Write those comments unquoted.
