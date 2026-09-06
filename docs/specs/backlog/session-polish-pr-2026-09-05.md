# Readable sessions and diffs

**Implemented in open PRs #194–#199; awaiting merge.** The approved scope grew to
include richer input and shortcuts, so it landed as a small stack, separate from
assessment-only PR #183. This implements a bounded part of the
[Phosphor proposal](phosphor-refinement-2026-09-05.md) to one everyday path:
**find a lane → read/steer → open a diff → return without losing context.**

## Approved core scope

1. **Reliable typography.** Bundle Inter and JetBrains Mono locally, with license
   notices and system/script fallbacks; no font CDN or new runtime font service.
   Account for font readiness in Monaco/xterm so cached measurements are not taken
   from the fallback face. Never block session startup indefinitely on a font error.
2. **Consistent preferences.** Make `MonacoDiff` use the existing editor font family
   and size, including live changes. It currently hardcodes 12 px / JetBrains Mono
   while the regular editor honors preferences (`MonacoEditor.tsx:219–224`).
   Keep existing chat/editor/terminal defaults, saved sizes and page zoom. This PR
   corrects consistency; it does not silently resize users' reading/editing surfaces.
3. **Focused visual polish.** In Sidebar, Composer and Changes, promote important
   copy to existing readable type steps and secondary/primary ink: roughly 13–14 px
   controls, 12+ px meaningful metadata. Strengthen title/secondary-row hierarchy,
   keep routing and PR information available, and remove only redundant framing.
   Apply sidebar changes to both persisted and pending rows. Keep Phosphor colors
   and session order; no global type-alias remapping or palette/satellite migration.
4. **Keyboard diff navigation.** Make opening a Changes row and returning from its
   diff work with the keyboard, with named controls and focus returned to the row.
   Use separate sibling buttons for open/revert, not nested buttons. Do not change
   restore logic or make Revert more prominent while its safety finding is open.

The core and two-line titles are implemented. The added input scope includes
undo-safe formatting, IME guards, links, expansion, scoped navigation shortcuts and
explicit streaming send controls; no workbench/orchestration features were added.

## Explicitly outside this PR

- Review Desk, receipts, attention-board logic, context passports, new navigation
  destinations, new layout/density preferences, onboarding or provider workflows.
- Shared modal focus-trap refactor or a whole-app accessibility claim. `ModalOverlay`
  has many consumers; nested dialogs deserve a dedicated implementation and tests.
- Baseline/restore safety, complete Git change inventory, PR readiness semantics,
  dependency upgrades, process/session lifecycle changes or artifact sandbox changes.
  The trust/recovery findings remain urgent; cosmetic polish does not resolve them.

## Merge bar

- Prove the bundled faces load offline and inspect actual rendered font sources,
  not just CSS family names. Check delayed/failed font loading and code alignment.
- Regression tests: diff honors font preferences before/after mount; keyboard
  open/back restores focus without triggering Revert; saved preferences survive.
- Before/after captures on the same fixture: light/dark, 1440×920 and 1000×740,
  plus 125%/150% page zoom. Exercise long names/paths, empty/loading/error states,
  streaming, draft/session switching, visible focus and reduced motion.
- Run typecheck, lint, formatting, unit tests, build and Electron e2e. Exercise the
  existing platform CI matrix; explicitly record any unverified platform behavior.
- Update the style guide, affected live docs and this plan; add a short dated log.
  Aim for at most 20 files and about 400 changed text lines, including tests/docs
  and license notices. Disclose font binary sizes. Cut optional polish, not tests.

## Implementation and evidence

Merge in order: [fonts #194](https://github.com/agustinsacco/pidex/pull/194) →
[diffs #195](https://github.com/agustinsacco/pidex/pull/195) →
[readability #196](https://github.com/agustinsacco/pidex/pull/196) →
[editing #197](https://github.com/agustinsacco/pidex/pull/197) →
[controls #198](https://github.com/agustinsacco/pidex/pull/198) →
[shortcuts #199](https://github.com/agustinsacco/pidex/pull/199).

At `7676d62`: typecheck/lint/format/build passed; 1,844 unit tests and 43 Electron
e2e tests passed. All six PRs have green Linux/macOS CI. Native captures covered
both themes, laptop widths and zoom. Independent review found no blocking defect;
a final twin check also reproduced/fixed terminal search reclaiming F6 focus.
An intermittent pinning-test failure passed unchanged targeted and full reruns.
No live-provider turns, manual Windows/OS-IME validation or screen-reader audit
were claimed. Recovery/readiness findings remain separate. Each PR is under 400
changed text lines and 20 files, including tests/docs/license notices.
