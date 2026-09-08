# 2026-09-04 — Skills page

A dedicated right-pane surface (sidebar → Skills) for everything pi resolves
as a skill, modeled on Claude Desktop's Customize → Skills: a **Yours** tab
grouped by where each skill lives, a **Discover** tab of curated libraries
with one-click install, plus create / upload / export / delete. Follows the
same lane as [2026-09-04-pi-loads-claude-skills.md](2026-09-04-pi-loads-claude-skills.md) —
pi is the single skill resolver, and Claude sessions receive skills through
pi's system prompt, so one page serves every provider.

## Resolution: ask pi, fall back to a scan

`electron/pi/skills.ts` `resolveSkills()` spawns a headless pi
(`PiRpcClient`, `noSession: true`) and reads `get_commands` — the same
discovery every session uses, so the list can't drift from what a session
actually loads. Each skill's `sourceInfo` gives path/scope/source/origin;
Phosphor enriches it with parsed frontmatter, the file tree, and provenance.

When the probe fails **or returns zero skills**, a filesystem scan of the
known roots takes over (`~/.pi/agent/skills`, `<ws>/.pi/skills`, plus any
`skills` arrays in pi/project settings, `~` and relative paths resolved). The
pane labels this state ("this list is a scan"). The zero-skill fallthrough is
deliberate: the e2e pi stub answers `get_commands` with no skills, so e2e
exercises the scan path deterministically.

Honesty rules baked into the model:

- **writable** = under a Phosphor-managed root and not from a package. Package
  skills and settings-listed foreign dirs (e.g. borrowed `~/.claude/skills`)
  render read-only; there is no fake enable toggle.
- **draft** = `disable-model-invocation: true` — a real Agent Skills flag,
  not Phosphor state. Hide/publish just rewrites that frontmatter key.
- Grouping is by root, not scope: `~/.claude/skills` and `~/.pi/agent/skills`
  are both "user" to pi, and telling them apart is the point.

## IPC and guards

Nine channels (`skills:list/readFile/create/writeFile/delete/export/install/importPick/importConfirm`)
in `shared/ipc.ts` + `electron/ipc/skills-handlers.ts`; types in
`shared/skills.ts`. Every path from the renderer is validated in main:
containment inside a known skill dir (the resolver registers them), refusal
to write read-only dirs or the provenance sidecar, name validation
(`^[a-z0-9]+(-[a-z0-9]+)*$`, ≤64), 2MB read cap with binary detection.

## Catalog installs

`shared/skillsCatalog.ts` pins three libraries by commit SHA (like the
extensions catalogue): `anthropics/skills` (19), `obra/superpowers` (13),
`addyosmani/agent-skills` (10) — descriptions harvested verbatim at the
pinned SHAs. Install fetches the GitHub zipball
(`codeload.github.com/<repo>/zip/<sha>`), extracts exactly one
`<subpath>/<skill>/` subtree into the global root, and writes a
`.phosphor-skill.json` sidecar (`catalogId/repo/sha/subpath/installedAt`) so
the detail view can offer **Update** when the catalog pin moves. The zipball
is cached per repo@sha for the app's lifetime.

`electron/pi/zip.ts` is a dependency-free reader/writer: EOCD + central
directory parse, and a refusal list — path traversal, absolute paths,
backslashes, NUL, symlink entries (external attrs `S_IFLNK`), entry/size
caps, declared-size mismatches. Import (`Upload`) reuses it for `.zip` /
`.skill` bundles (single top-level folder unwrapped) and also accepts a bare
`SKILL.md`.

## Renderer

`src/features/skills/SkillsPane.tsx` + `NewSkillModal.tsx`, zustand store
`src/stores/skills.ts` (keyed `byWorkspace`), `'skills'` added to the
`RightPane` union, nav row under Artifacts. The Advanced settings tab's
resource grid dropped its skills card (extensions/prompts/themes remain) and
points here. Mock cases in `src/dev/mockPhosphor.ts` keep browser-only dev
working.

## Tests

- `shared/skills.test.ts` — name/frontmatter/draft-flag/compose/warnings.
- `electron/pi/zip.test.ts` — round-trip, traversal/symlink/size-mismatch
  refusal, deflate (GitHub zipballs) support.
- `electron/pi/skills.test.ts` — scan fallback, containment, create/delete,
  export excludes the sidecar, install with an injected `fetchZip` (URL
  asserted against the pin), import md/zip/override-name.
- e2e (`smoke.spec.ts`): seeds a skill in a private agent dir, opens the
  page, checks the row + Discover, and creates a skill through the modal,
  asserting the bundle lands on disk.
