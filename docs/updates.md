# Updates

How a running Phosphor learns about a new release and installs it. The release
pipeline is
[.github/workflows/release-continuous.yml](../.github/workflows/release-continuous.yml);
this document is the client half. The workflow publishes each release with
GitHub's generated notes: every pull request merged since the previous
_published_ release, so `Skip-Release` merges appear in the build that ships
them. If that lookup fails, the release still publishes with install notes
only.

Everything here is **hard-gated on `app.isPackaged`**. Dev runs, the browser
harness and the Playwright suite never reach the network for an update check,
and `electron-updater` is imported lazily so an unpackaged run does not load it.

## Three paths, chosen once at startup

`resolveUpdatePath()` in [apps/desktop/electron/updates/updater.ts](../apps/desktop/electron/updates/updater.ts)
picks one and caches it for the life of the process.

| Path       | When                                                           | What a click does                   |
| ---------- | -------------------------------------------------------------- | ----------------------------------- |
| `updater`  | `phosphorSigned` **and** (signed macOS \| AppImage \| Windows) | `electron-updater` `quitAndInstall` |
| `mac-self` | unsigned macOS, bundle writable, not translocated              | swap the bundle, relaunch           |
| `manual`   | anything else (`.deb`, read-only bundle)                       | open the releases page              |

`phosphorSigned` is stamped into the packaged `package.json` by CI, not probed
at runtime, so the UI knows before the first check whether it can promise a
restart. It is `true` for every Linux build (AppImage self-updates without a
signature), for every Windows build, and only for macOS builds where
`MAC_CERT_P12` was set.

**A `.deb` is deliberately `manual`.** The package manager owns those files.

**Windows is `updater` even unsigned.** The NSIS installer is per-user
(`perMachine: false` in [electron-builder.yml](../apps/desktop/electron-builder.yml)), so
`electron-updater` can replace the install without elevation, and it only
verifies the downloaded installer's Authenticode signature when the running
app carries a `publisherName` to compare against — an unsigned build does not,
so the check is skipped rather than failed. The manifest it polls is
`latest.yml`. What signing would buy is the SmartScreen interstitial on first
install, not the update path; `WIN_CERT_PFX` / `WIN_CERT_PASSWORD` turn it on
in the release workflow when they exist.

## Why macOS needs its own installer

Electron's `autoUpdater` on macOS is Squirrel.Mac, which validates the
downloaded bundle against the **running** app's designated requirement.
Phosphor ships ad-hoc signed (no Developer ID) and unnotarized, and nothing
here is tested against Squirrel.Mac. Setting `phosphorSigned=true` for macOS
would trade "opens a browser" for "errors silently".

So [apps/desktop/electron/updates/mac-installer.ts](../apps/desktop/electron/updates/mac-installer.ts)
does by hand what `tools/scripts/install.sh` does by shell:

1. Read `latest-mac.yml` and pick the zip matching `process.arch`. The
   manifest lists x64 first, so the arch test is two-sided; "first zip wins"
   installs Intel on Apple silicon.
2. Download and check the manifest's base64 `sha512`. A mismatch aborts.
3. Expand with `ditto -x -k`, **not `unzip`**. ditto preserves the symlinks,
   permissions and xattrs the bundle's signature is computed over.
4. Strip `com.apple.quarantine`, `codesign --verify --deep --strict`, and
   confirm `CFBundleShortVersionString` is the expected version. A bundle that
   fails here never reaches `/Applications`.
5. On the user's click: two renames, then relaunch.

Staging lives **beside the installed bundle**, not in `/tmp`, so step 5 is two
atomic same-volume renames rather than a multi-second copy that can half-fail.
If the second rename throws, the first is undone and the running app is
untouched.

## The relaunch must wait for the old process

[apps/desktop/electron/main.ts](../apps/desktop/electron/main.ts) holds a single-instance lock, and
`before-quit` SIGTERMs every pi child, kills the PTYs and closes the watchers
before quitting. A replacement that starts too early takes the
`second-instance` path, focuses the window that is already dying, and exits,
leaving no app.

`spawnRelauncher` therefore writes a detached `/bin/sh` script that polls
`kill -0` on our pid (bounded at 60s), deletes the backup bundle, and only then
runs `/usr/bin/open -n`. `open` rather than exec'ing the binary, so
LaunchServices registers the process and gives it a Dock tile.

Paths reach that script as positional arguments. Nothing from the network is
interpolated into a shell string anywhere in this module.

## Orphan sweep

A crash between "extracted" and "swapped" strands several hundred MB beside the
app. `sweepOrphans` runs once at startup, the only moment no swap can be in
flight, and removes entries matching exactly
`.phosphor-update-<pid>-<stamp>` or `.phosphor-old-<pid>-<stamp>.app` in the
bundle's own parent directory. A bare prefix test is not enough: this is
`rm -rf` next to a user's `/Applications`.

Staged bundles are not left for the sweep when the app knows they are dead.
A newer release found while one is staged replaces it, and a failed swap
discards it. The superseded bundle is deleted only after the phase has left
`downloaded`, and an install takes its bundle out of reach before swapping, so
a background check can never delete the bundle being installed.

Every bundle deletion runs `/bin/rm -rf`, never Node's `fs.rm`. Inside
Electron, `fs` reads each `*.asar` file as a directory, so a recursive `fs.rm`
of a bundle removes everything except `Contents/Resources/app.asar` and fails
with ENOTEMPTY. Plain-Node unit tests cannot see that, so
`mac-installer.test.ts` also runs the real sweep in the Desktop install's
Electron, against a copy of Electron's own `default_app.asar`.

## What an update does NOT touch

Nothing persistent lives inside the bundle, so a swap resets no state:

- `~/Library/Application Support/Phosphor/config.json` — every pref. Located by
  app **name**, not bundle path.
- `~/Library/Logs/Phosphor/` — the debug log.
- `~/.pi/`, `~/.claude/` — pi's sessions and settings, the Claude provider's
  transcripts.
- `<workspace>/.pi/` (its `mcp.json` included), `<workspace>/.phosphor/`.
- MCP OAuth tokens. pi keeps those in its own agent directory, under `~/.pi/`.

The only bundle-internal thing read at runtime is `process.resourcesPath/pi-ext`,
the shipped extension sources, which the new version _should_ replace.

**An unfinished turn can be lost on restart.** Pi persists it only when the
turn ends. Quit and update restart ask for confirmation when main observes
active or unconfirmed session work, pending routines, or any open terminal.
Keep working is the default; Stop work explicitly authorizes termination, not
a guaranteed save. Cancel leaves processes, terminals, and watchers intact.

Approval comes before a macOS bundle swap or `quitAndInstall`. New sessions,
agent commands, terminals, and routine admission are blocked after approval;
inspection and abort commands remain available. Duplicate quit/update requests
cannot share an approval to launch competing installs. Failed update preparation
reopens admission unless teardown has already begun.

On Windows/Linux, closing the final window asks before destroying its renderer
unless background routines keep the app alive. macOS window-close behavior is
unchanged. This guard does not yet provide editor save/discard prompts, a
wait-until-finished action, or an interruption recovery journal. OS signals and
force-quit bypass confirmation.

### TCC grants survive an update

macOS privacy (TCC) records the app's **designated requirement** beside every
"Allow" you click and re-checks it on the next launch. A plain `codesign
--sign -` derives that requirement from the code hash, which changes every
build, so every auto-update would invalidate every grant and re-prompt for
Downloads / Documents / Desktop. With a release on every green merge, that is
roughly daily.

[apps/desktop/scripts/adhoc-sign-mac.mjs](../apps/desktop/scripts/adhoc-sign-mac.mjs) therefore signs with
an explicit `-r=designated => identifier "works.phosphor.app"`, stable across
builds, and asserts the result before the build passes. It must be the inline
`-r=<text>` form; as separate arguments `codesign` reads the text as a file
path. Nested code (Helpers, Frameworks) is sealed first without the
requirement, then the outer bundle alone is re-signed with it, because
re-signing sealed nested code fails `--verify --deep --strict`.

This does not weaken anything: an ad-hoc signature has no anchor, and anyone
who can replace the app in `/Applications` can re-sign it under any identifier.
A real Developer ID gets a stable team-anchored requirement from
electron-builder and skips this hook.

The prompts still appear **once**, on first access to each folder;
`mac.extendInfo` in [electron-builder.yml](../apps/desktop/electron-builder.yml) supplies the
`NS*FolderUsageDescription` strings so the dialog says why.

## The state machine

[apps/desktop/electron/updates/update-state.ts](../apps/desktop/electron/updates/update-state.ts) is a
pure reducer, so every transition is unit tested without a packaged app or a
network. Phases: `idle`, `checking`, `downloading`, `installing`, `downloaded`,
`manual-download`, `unsupported`. `installing` is macOS-only.

Three rules:

- **A failed check is never surfaced.** `error` collapses to `idle`. Offline is
  not your problem to solve and must not nag.
- **Work in flight is never interrupted.** `check-started` and
  `update-not-available` are ignored while downloading, installing or staged;
  the 30-minute timer will land mid-download sooner or later.
- **A failed self-install degrades to `manual-download`, not to silence.**
  `install-failed` carries the release URL, so you keep a way out.

`checkForUpdates` also guards re-entry: a macOS download takes minutes and the
timer would otherwise start a second one on top of it.

## Surfaces

- `UpdatePill` (sidebar footer) renders only `downloading`, `installing`,
  `downloaded`, `manual-download`. Only the last two are clickable, because only
  those can do anything.
- Settings → About has **Check now**, the one way to ask "am I current?" while
  the pill is hidden.
