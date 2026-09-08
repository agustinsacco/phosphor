# The app is now Phosphor (was: pidex)

The product took its design system's name. "Phosphor" (capital P, a proper
noun) replaces "pidex" (which was lowercase always) everywhere: product name,
repo, bundle, protocol scheme, preload API, env vars, branch prefix, docs.
The GitHub repo was renamed to `agustinsacco/Phosphor`; GitHub redirects the
old `agustinsacco/pidex` URLs for git remotes, releases and the API, so
existing installs keep updating.

## One caveat on history

Every dated file in `docs/log/` was renamed wholesale. Where a log written
before this date says "Phosphor", the app it describes was still called pidex
at the time. The rename was chosen over historical fidelity because the point
of this change was to evaporate the old name completely. One deliberate
survivor: a verbatim `~/.claude/projects` cwd fixture in
`electron/pi/pi-paths.test.ts`, whose hash is computed over the exact bytes of
a pre-rename path.

## The rename map

| Was                              | Is                                        |
| -------------------------------- | ----------------------------------------- |
| productName `pidex`, `pidex.app` | `Phosphor`, `Phosphor.app`                |
| appId `works.pidex.app`          | `works.phosphor.app`                      |
| package name `pidex`             | `phosphor` (npm names are lowercase)      |
| `window.pidex` / `PidexApi`      | `window.phosphor` / `PhosphorApi`         |
| `pidex-artifact://`              | `phosphor-artifact://`                    |
| `PIDEX_*` env hooks              | `PHOSPHOR_*`                              |
| `<repo>/.pidex/worktrees/`       | `<repo>/.phosphor/worktrees/` (new lanes) |
| branch prefix default `pidex/`   | `phosphor/` (stored user prefs win)       |
| `.pidex-skill.json` sidecar      | `.phosphor-skill.json` (legacy read)      |
| `~/Library/Logs/pidex/pidex.log` | `~/Library/Logs/Phosphor/phosphor.log`    |
| userData `.../pidex`             | `.../Phosphor` (migrated on launch)       |

## Migration behavior shipped with the rename

- **userData**: Electron derives the directory from the app name, so the first
  Phosphor launch renames the sibling `pidex` directory into place when the
  new one does not exist yet (`electron/main.ts`, before anything resolves
  `userData`). Prefs, drafts, layout and window state survive the update.
- **Existing lanes**: worktrees created before the rename live under
  `.pidex/worktrees`. Worktree listing always came from `git worktree list`,
  so they stay visible; the path-shape checks
  (`src/lib/path.ts`, `electron/store.ts`) accept both directory names. New
  lanes are created under `.phosphor/worktrees`.
- **mac update sweep**: the release that renames the app is downloaded and
  staged BY the last pidex build, so its staging/backup leftovers use the old
  `.pidex-update-` / `.pidex-old-` prefixes. `ORPHAN_RE` in
  `electron/updates/mac-installer.ts` matches both prefixes.
- **Skill provenance**: the `.pidex-skill.json` sidecar is still read (never
  written) so previously installed skills keep their catalog identity.
- **install.sh**: retires `/Applications/pidex.app` and the Linux
  `bin/pidex` / `pidex.desktop` artifacts when upgrading.

## What existing installs will see

- Auto-update keeps working: the updater matches release assets by suffix
  (`-arm64-mac.zip`, `latest-mac.yml`), not by name, and GitHub redirects the
  renamed repo's `releases/latest/download` URLs.
- On macOS the swap replaces the bundle **at its current path**, so an updated
  install keeps the `pidex.app` filename (containing Phosphor) until the user
  renames it or reinstalls via `install.sh`/DMG. Cosmetic only.
- The appId changed, so macOS treats Phosphor as a new app for TCC: the
  per-folder access prompts will appear once more.
- pi session files are keyed by cwd. Renaming a workspace folder on disk (e.g.
  `~/pidex` → `~/Phosphor`) parks the old sessions under the old mangled-cwd
  directory; they are not lost, but they no longer attach to the renamed
  workspace path.

## Deliberately NOT renamed

- The `--px-*` CSS token namespace. It never contained the string "pidex",
  changing it means touching all five hand-mirrored satellite palettes for
  zero user-visible gain, and "px" reads fine under the new name.
- The dark accent color is still called **phosphor** (lowercase) when named as
  a color; see the Voice section of [style-guide.md](../style-guide.md).
