# 2026-09-09 — The working record website

Rebuilt the Phosphor website around human-agent iteration rather than a long
feature inventory. The existing Astro site was reviewed for its static build,
shared components, image pipeline, and nginx/k3s deployment structure, not as a
visual reference. No separate Astra project was located in the available repo.

## What changed

- Four static routes: homepage, workbench, download, and a public design-language
  reference. The homepage tells the direct → inspect → revise story; technical
  depth and installation have their own reading paths.
- Slate-paper reading surface, warm graphite working passages, numbered
  margins, Inter / JetBrains Mono, and restrained ember actions. No decorative
  gradients, animation loops, provider marquee, or nested feature cards.
- Reused the real product captures with descriptive captions and full-size
  links. The hero gallery becomes accessible tabs with JS; without it, the
  figures remain readable as an ordinary document.
- Download commands have live-region feedback and a real selection fallback
  when clipboard access fails. Setup explains provider billing, cloud requests,
  full-permission execution, and the difference between worktrees and sandboxes.
- Shared layout, navigation, screenshot, and command components. Retired unused
  animated mark, beacon, architecture, and simulated terminal components.
- A new social image and local reproducible generator. The existing deployment
  pipeline and app icon are unchanged; the small wordmark uses the sanctioned P.
- `docs/site-design.md` records the audience, visual grammar, plain-language
  feedback translations, and extension rules for future pages. The desktop
  app's design system and artifact stylesheet are unchanged.

## Validation

- Root `SKIP_E2E=1 npm run validate`: typecheck, lint, format, and all **2,113 unit
  tests** passed. The first run hit Electron's concurrent first-import binary
  installation; a sequential import completed installation and the rerun passed.
- Astro check: zero errors, warnings, or hints. Static build: four routes.
- Site Playwright: **20 tests passed** across desktop and mobile Chromium,
  including axe WCAG A/AA checks on all routes, image delivery, internal links,
  metadata, keyboard tabs, clipboard success/denial, no JavaScript, reduced
  motion, and overflow checks at 320 / 768 / 1920 CSS pixels.
- Visual review of desktop and mobile pages, including full-size real captures
  and the social image. Corrected small ember-link contrast using the existing
  darker brand token rather than accepting the original 4.4:1 contrast.
- CI now runs the site browser suite before deployment can follow a green
  merge. Electron E2E was not run: no app renderer, IPC, or session code changed;
  the changed web flows have their own browser E2E coverage.
