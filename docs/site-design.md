# Website design language — The working record

The website speaks to **people who delegate implementation, not judgment**.
Its promise is “Keep the work in your hands”: visibility and iteration, not
approval-gated execution. The app still runs pi with full tool permissions.

[style-guide.md](style-guide.md) remains the authority on Phosphor's mark,
colors, and font families. This document owns their **website expression**.
It does not change the desktop app or the artifact house style. The public,
plain-language reference is `/design`.

## What was reviewed

The existing reference in this repository was the Astro site in `site/`;
no separate Astra project was located. Its structure was a single long page
with shared navigation, footer, screenshot framing, diagrams, terminal output,
a static layout, and a content module. It was built as static HTML with
responsive images, then served by nginx and deployed through the existing
Docker/k3s workflow.

Keep that technical foundation and the real product captures. Do not carry
forward the design: glow fields, animated electron-shell scenery, provider
marquees, nested cards, repeated three-column grids, or feature-count selling.
The old page mixed introduction, reference manual, internal implementation
notes, and installation into one reading path. The new site separates those
jobs.

## Audience and position

Primary readers are developers, technical founders, and small software teams
already using coding agents. They understand files, branches, diffs, terminals,
and model providers. They need a legible working environment, not an
explanation that AI can write code.

The distinctive product relationship is a loop:

```text
person: direction → agent: implementation → person: inspection
       ↑                                      ↓
       └────────── revised direction ──────────┘
```

Product claims start with a human action: direct, inspect, revise, compare,
revert. Avoid autonomous-team promises, invented performance statistics, and
claims that Phosphor includes a model subscription or keeps cloud inference
on the local machine.

## Visual grammar

- **Reading surface:** the brand's cool slate paper. It gives the website a
  different composition from the dark app without inventing a different brand.
- **Working surface:** warm graphite for the human-agent loop and substantial
  artifact discussion. A surface change means a change of purpose; sections
  do not alternate colors mechanically.
- **Accent:** ember on paper, phosphor amber on graphite. Use it for the next
  action, selected screenshot, and directional marks. Small paper links use
  the existing darker ember hover value: the ordinary ember is only 4.4:1
  against paper and fails AA for small text. Never white text on dark-theme
  amber. No large accent backgrounds or decorative gradients.
- **Typography:** locally hosted Inter for argument and explanation;
  JetBrains Mono for the wordmark, indexes, labels, commands, and technical
  metadata. Headlines are sentence case, medium weight, tightly spaced, and
  sparse. Mono is structural, not a simulation of a terminal session.
- **Composition:** a shared outer margin and a narrow numbered index beside
  the main reading column. Related prose is grouped by whitespace; unrelated
  ideas are separated by rules. At narrow widths the index moves above the
  content; navigation remains visible and wraps instead of disappearing.
- **Shape:** hairline borders and near-square corners. Only actual objects
  and controls receive frames. Never put paragraphs into cards by default.
- **Evidence:** original product captures with useful captions, correct alt
  text, responsive image variants, and a full-size link. No added window
  chrome, perspective tilt, glow, fabricated dashboards, or fake usage data.
- **Interaction:** one filled primary action per viewport. Ordinary
  navigation remains links. Screenshot selection responds directly to the
  reader; no autoplay, entrance animation, or content hidden pending scroll.
- **Motion:** none is needed for the current pages. Smooth anchor scrolling
  respects reduced motion. Future motion must explain a state change, not
  manufacture activity.

The implementation is `site/src/styles/global.css`: role classes such as
`display`, `title`, `lede`, `label`, `section-grid`, `fact-list`, and `shot`.
Website headline sizes are fluid; they are not the dense app-chrome scale.
The website's descriptive custom-property names map to existing brand values,
not an independently tuned palette.

## Page responsibilities

| Route        | Reader's question                     | Evidence / next action                                                 |
| ------------ | ------------------------------------- | ---------------------------------------------------------------------- |
| `/`          | Why would I want this workspace?      | Real pane selector, working loop, lane board; install or explore       |
| `/workbench` | How does it fit how I work?           | Transcript, artifacts, independent lanes, provider table, extensions   |
| `/download`  | What do I need and what will run?     | Platform paths, exact commands, setup, permissions and data boundaries |
| `/design`    | How do we keep future pages coherent? | Audience, grammar, plain-language feedback translations, review rules  |

Technical depth links to the existing repository documentation. Download links
lead to release pages, not guessed binary URLs. Windows assets are produced
by the tag-triggered Release workflow, not every per-merge release; a `v*`
tag name alone is not evidence that the release contains an executable.

## Plain-language iteration

| Feedback            | Translate into a design decision                                         |
| ------------------- | ------------------------------------------------------------------------ |
| “Too busy”          | Remove competing emphasis; replace unnecessary containers with rules     |
| “More human”        | Name the reader's decision and use a concrete example, not a mascot      |
| “More punch”        | Strengthen the claim and headline contrast; don't increase every weight  |
| “Show what it does” | Add real, captioned evidence rather than illustrative product claims     |
| “Like the rest”     | Reuse margins, type roles, action hierarchy, and evidence grammar        |
| “Simpler”           | Shorten the path to the next decision; keep material limitations visible |

For each round: restate the user's reaction as an observable problem, name the
rule being changed, alter one variable, compare desktop and mobile, then keep
or revise. A successful change updates the shared rule and affected pages.
Do not patch a one-off visual exception into each page.

## Adding a page

1. Write the single question the page answers.
2. Select evidence appropriate to the question: screenshot, comparison table,
   command, or explanation. A card grid is not the default.
3. Start with `BaseLayout` and the indexed reading grid. Reuse `Shot` and
   `CopyCommand` where appropriate, not copied markup and scripts.
4. Choose one next action. Put qualifications beside the relevant claim.
5. Check keyboard use, 320px layout, 200%-zoom-equivalent layout, reduced
   motion, no JavaScript, actual image delivery, and truthful download paths.
6. Run the site browser suite and update this document if the grammar changes.

## Behavioral contracts

- All content is available without JavaScript. The evidence gallery begins
  as anchor links and visible figures; JS adds an accessible tab interface.
  Arrow keys, Home, End, Enter, and Space operate the tabs. Hash links to a
  particular figure remain supported after enhancement.
- Copy buttons appear only when the script runs. Success is announced through
  a live region. Clipboard failure focuses and selects the actual command,
  gives manual-copy instructions, and never reports success.
- Screenshots are static evidence, not a simulated app. They can be enlarged
  in a new tab. Captures may show an older model catalogue or account setup;
  never infer current availability from a screenshot's count.
- There are no provider-policy endorsements, customer metrics, or telemetry
  added by the website. Remote destinations are normal links, not background
  calls.
- The existing electron-shell icon remains the favicon. The website wordmark
  uses the sanctioned monochrome P path at small sizes; it does not redraw or
  retune the chemistry of the full icon.

## Validation

`npm run check --prefix site` checks Astro and TypeScript. `npm test --prefix
site` builds the static pages and runs Playwright on desktop and mobile Chromium:
all routes, metadata, internal anchors, image delivery, overflow at 320/768/1920,
keyboard tabs, clipboard success/failure, no-JS fallbacks, reduced motion,
and axe WCAG A/AA checks. CI runs the same suite. Automated accessibility is
not a substitute for checking reading order and reviewing the page visually.
