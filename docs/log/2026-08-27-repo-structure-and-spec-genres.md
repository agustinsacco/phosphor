# The specs could not tell you which of them to believe

2026-08-27. A structure-and-organization review of the whole repo, then the
cleanup it turned up. Eight items, all landed here.

## What the review found

The code is in better shape than the docs. `src/` already splits into
`app/` / `features/` (13) / `stores/` / `lib/` / `components/` / `styles/`, and
`electron/` into `pi/` / `pty/` / `fs/` / `ipc/` / `orchestrator/` / `updates/`.
Horizontal duplication is nearly gone: across ~53k lines there were exactly
**three** duplicated exported symbols, all of them the `src/`-versus-`electron/`
split that `shared/` exists to prevent.

The docs were the problem, in three distinct ways.

**1. No genre marking.** `specs/` held four kinds of document under one flat
numbering scheme: original pre-implementation requirements, living contracts,
open audit backlogs, and history. Nothing in a filename said which. Four files
(`05`, `07`, `08`, `10`) had a single commit each, from 2026-08-03, and had
never been revised through 24 days of heavy development — but they sat as peers
next to `13-orchestration.md`, which had four commits and was current.

**2. A contradiction with teeth.** `00-overview.md` still specified a
terracotta/coral accent and a serif display face. The Phosphor restyle retired
both on 2026-08-07, and `STYLE_GUIDE.md` says in as many words: don't
reintroduce terracotta, serif is dropped from the brand voice. The code has zero
terracotta hexes. So the product overview had been instructing readers to
restyle backwards for 20 days, and `IMPLEMENTATION_PROMPT.md` — still in the
repo root — told an agent to read `00-overview.md` _first_.

**3. Three copies of the repo layout, all wrong.** `README.md`,
`01-architecture.md` and `CLAUDE.md` each described where things live. The
architecture copy named a `types/ipc.ts` that has never existed, listed 6 of 13
feature folders, 2 of 5 pi extensions, and 5 of 13 IPC prefixes. The README
called `pi-ext/` "bundled pi extension (artifacts tools)", singular.

## The screenshots were never ours

`TRACKER.md` carried an open P10 box: "regenerate `specs/screenshots/`; the PNGs
still show the pre-Phosphor UI." That box was unsatisfiable, because the
premise was wrong. Every one of the 15 captures was of **Anthropic's Claude
Desktop**, taken during the original cloning study — `home-light.png` shows its
Home/Code tabs and an "Agustin · Pro" account row. There was no Phosphor UI in them
to regenerate.

Phosphor makes the resemblance an explicit non-goal, so 8.7MB of a different
product's UI was serving a design study the project had already abandoned, while
two live docs still called it "the visual quality bar". Deleted, and P10 closed.

## What changed

`specs/` now splits by genre, with a `README.md` that says which folder to trust:

| Folder       | Genre                                | Trust              |
| ------------ | ------------------------------------ | ------------------ |
| `reference/` | living contracts, 13 files           | yes — fix on drift |
| `build/`     | the 4 never-revised requirement docs | no — historical    |
| `backlog/`   | audits with open findings            | per-finding status |
| `log/`       | dated write-ups                      | as history         |

Reference files lost their numeric prefixes, which stopped meaning anything once
the set was split (`overview.md`, `architecture.md`, `orchestration.md`, …).
`build/` kept its numbers, gaps and all, because there the gaps are the honest
record of what got promoted out. Both new folders carry a README naming the
specific staleness in each file rather than a general warning.

Deleted: `IMPLEMENTATION_PROMPT.md` (a build prompt for a finished build),
`specs/screenshots/`, `TECH_DEBT_AUDIT.md` (landed 2026-08-06; every item
verified fixed, and its "largest remaining files" table was stale in all five
rows — `reducer.ts` 620→704, `Composer.tsx` 456→622, `mockPhosphor.ts` 493→1229),
and the whole of `specs/archive/`.

### There is no archive any more

`specs/archive/` held nine landed plans behind a README that opened "nothing
here is a live contract". That is an accurate warning and also an admission: a
folder whose own index tells you not to trust it is not documentation, it is
sediment. Git already keeps every one of those files.

Deleting it was not free, and the cost was worth naming rather than discovering
later. Three live documents were leaning on it, and each was repaid in place
instead of left dangling:

- **`style-guide.md` deferred two live facts to `RESTYLE_PLAN.md`** — which
  surfaces carry a mirrored copy of the palette, and the migrate-atomically
  rule. Both are inlined now, as an actual table of the five satellite
  surfaces and their files. Building that table turned up a small divergence
  nobody had ruled on: `window-chrome.ts`'s light titlebar colour is `#f7f7f8`
  where `--px-bg` light is `#f7f6f2`.
- **`TRACKER.md`'s P0–P9 section was a pure pointer** at
  `archive/TRACKER-P0-P9.md`. It now carries the `git show` incantation instead.
- **P11's two open boxes referenced `CHAT_UX_PHASE0_PLAN.md` phases 2–5** and
  would have become unactionable. Those four phases are inlined into
  `TRACKER.md` with their intent preserved — and checking them against the code
  showed the boxes were **already stale**: phase 2 shipped by a different route
  (the 2026-08-20 type scale, without the `--px-fs-*` tokens the plan proposed),
  phase 3 looks delivered by P13's `ActivityGroup`, phase 4's `MessageActions`
  was never built because P13 shipped a hover pill instead, and phase 5's
  `Notice` primitive is genuinely open. That reconciliation is flagged in
  `TRACKER.md` as needing verification rather than silently re-ticked.

### Both backlogs now carry per-finding status

Neither had any, which is what made them unreadable: real measured findings,
some fixed, no way to tell which. Re-verified by reading the cited code, not by
trusting the documents.

- `perf-findings.md`: **17 open, 1 fixed, 1 moot** of 19. F14 was fixed by the
  P12 sidebar work (`git-info.ts` has a TTL cache and in-flight dedupe now).
  F15 is moot — its cost was the floating monitor window, which no longer
  exists. Everything else still reproduces: F5's dead `partial` handling is
  still in `shared/rpc.ts`, `releaseWorkspace` still has no caller outside its
  own test, `pi:listLiveSessions` still has zero callers.
- `cleanup-plan.md`: **phases 1–5 landed**, phase 6 open by design. One loose
  end recorded: `rewind.ts:43` still returns `null` on RPC failure with no
  comment saying the silence is intended, which the plan had asked for a
  decision on.

## One test convention

`CLAUDE.md` said "tests live beside their subject as `*.test.ts`". That was true
of `src/` (65 files) and false of everything else: `electron/`, `shared/` and
`scripts/` used `__tests__/` directories holding 41 suites, and `pi-ext/` used
both at once. All 41 moved beside their subjects; the eight `__tests__/`
directories are gone. `electron/pi/__tests__/fixtures/` became
`electron/pi/__fixtures__/`, matching `src/features/chat/__fixtures__/`.

No vitest config change was needed — the include patterns were already
`**/*.test.ts`. 16 files carried now-stale `__tests__/` pointers in prose and
code comments (including a CI workflow comment); all rewritten, and all 23
test-file pointers in the repo verified to resolve.

## Three helpers that existed twice

Each had one copy in `src/` and one in `electron/`, and two of the three pairs
had drifted into genuinely different behaviour.

**`stripAnsi`.** The renderer's handled CSI, OSC with an optional terminator,
and two-byte escapes; the main process's handled CSI and terminated OSC only.
The whole module moved to `shared/ansi.ts` — it was already pure data-in,
data-out. `login-flow.ts` keeps the part that is actually its own, under an
honest name: a bare CR means the TUI redrew that row, so it reads as a line
break, and that is `screenText`, not "strip ANSI". Its three stripper tests pass
unchanged against the broader pattern.

**`isNewerVersion`.** The renderer's understood prereleases but mapped an
unparseable segment to `0`; the updater's dropped prereleases but refused to
claim an update on malformed input. Each lacked the other's protection.
`shared/version.ts` is the union, and both original suites pass against it.
Behaviour change worth naming: a pi package whose _installed_ version cannot be
parsed no longer offers an update, where before it compared as `0` and could.

**`claudeProjectDirName`.** This one was a live bug, not just duplication. The
renderer carried the character substitution but not the CLI's 200-character cap,
with a comment conceding the main-process copy was authoritative. So a session's
copyable debug block printed a path that cannot exist once the mangled cwd got
long enough — and that is reachable, because these sessions run in worktrees
nested under `.claude/`. `shared/claude-paths.ts` now carries the full rule and
both sides use it.

## Left alone, deliberately

- **25 cross-feature import edges**, with cycles (`chat ↔ sessions`,
  `chat ↔ orchestrator`, `chat ↔ extension-ui`, `home → chat` five times). The
  `features/` folders imply an isolation that does not exist. Real, but fixing
  it means moving shared surfaces out into `components/` or `lib/` and is a
  behavioural-risk refactor, not a docs pass.
- **`src/components/` is a mixed bag** — primitives (`Modal`, `PopupMenu`,
  `form`, `icons`) next to feature widgets (`ComposerButtons`, `RunCommandRow`,
  `StatTile`) and a hook.
- **`e2e/smoke.spec.ts` is one 1557-line file with 28 tests.**
- **`specs/reference/settings.md` documents 5 tabs; 12 ship.** Same class of
  drift as the brand section, smaller blast radius.

## Verification

`npm run typecheck`, `npm run lint`, `prettier --check`, 107 unit files / 1173
tests, and the e2e matrix — all green. Two link checkers were written for the
move and run as gates: every relative markdown link in the repo (110) and every
bare `specs/….md` path in prose or code comments resolves.
