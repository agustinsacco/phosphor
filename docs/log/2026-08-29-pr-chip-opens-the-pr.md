# 2026-08-29 — the PR chip becomes the way into the PR

The sidebar's PR chip ([#110](https://github.com/agustinsacco/Phosphor/pull/110))
told you a lane's pull request state and then made you go find it yourself.
It is now the shortcut: click it and the PR opens in your browser.

## Why the chip is a `span` and not a `button`

A `<button>` inside a `<button>` is invalid HTML, and a lane row IS a button —
the same trap `SessionRow`'s inline rename editor already documents (it swaps
the row to a `<div>` while the text field is up, precisely to avoid nesting an
interactive element inside one).

So the chip is a `role="link"` span with `tabIndex={-1}`:

- **A mouse target**, with `cursor-pointer` and a hover underline, so it reads
  as something you can click rather than a status pill.
- **Explicitly not a tab stop.** Making it focusable would put a second tab
  stop on every lane in the sidebar, so tabbing through the session list would
  alternate row, chip, row, chip.

`stopPropagation` matters here and is easy to miss: the row underneath opens
the session, so without it one click both opened the PR in a browser and swapped
the session out from under it. There is a test for exactly that.

## The keyboard route is the context menu

`tabIndex={-1}` leaves keyboard users with no way to reach the PR, so the row's
context menu carries **Open pull request #N** with the PR's state as its hint.
That is also the only way to see the PR number without hovering.

The two are a pair. Removing the menu item to "simplify" makes the feature
mouse-only; making the chip focusable puts the sidebar's tab order back to
double length. `PrBadge.tsx` says so at the top.

## Not done: a "create PR" affordance

A lane with a pushed branch and no PR still renders an inert `↑ no PR` chip.
Turning that into a create button was considered and rejected for now:
`electron/fs/gh-cli.ts` is read-only by design, and its own header says why —
"no push, no create. Those are outward-facing writes and belong behind an
explicit, confirmed action." A one-click PR from a sidebar chip is not that.
