# Updates

How a running Phosphor learns about a new release and installs it. The release
pipeline is
[.github/workflows/release-continuous.yml](../.github/workflows/release-continuous.yml);
this document is the client half.

Everything here is **hard-gated on `app.isPackaged`**. Dev runs, the browser
harness and the Playwright suite never reach the network for an update check,
and `electron-updater` is imported lazily so an unpackaged run does not load it.

## Three paths, chosen once at startup

`resolveUpdatePath()` in [electron/updates/updater.ts](../electron/updates/updater.ts)
picks one and caches it for the life of the process.

| Path       | When                                                | What a click does                   |
| ---------- | --------------------------------------------------- | ----------------------------------- |
| `updater`  | `phosphorSigned` **and** (signed macOS \| AppImage) | `electron-updater` `quitAndInstall` |
| `mac-self` | unsigned macOS, bundle writable, not translocated   | swap the bundle, relaunch           |
| `manual`   | anything else (`.deb`, read-only bundle)            | open the releases page              |

`phosphorSigned` is stamped into the packaged `package.json` by CI, not probed
at runtime, so the UI knows before the first check whether it can promise a
restart. It is `true` for every Linux build (AppImage self-updates without a
signature) and only for macOS builds where `MAC_CERT_P12` was set.

**A `.deb` is deliberately `manual`.** The package manager owns those files.

## Why macOS needs its own installer

Electron's `autoUpdater` on macOS is Squirrel.Mac, which validates the
downloaded bundle against the **running** app's designated requirement.
Phosphor ships ad-hoc signed (no Developer ID) and unnotarized, and nothing
here is tested against Squirrel.Mac. Setting `phosphorSigned=true` for macOS
would trade "opens a browser" for "errors silently".

So [electron/updates/mac-installer.ts](../electron/updates/mac-installer.ts)
does by hand what `scripts/install.sh` does by shell:

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

[electron/main.ts](../electron/main.ts) holds a single-instance lock, and
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

## What an update does NOT touch

Nothing persistent lives inside the bundle, so a swap resets no state:

- `~/Library/Application Support/Phosphor/config.json` — every pref. Located by
  app **name**, not bundle path.
- `~/Library/Logs/Phosphor/` — the debug log.
- `~/.pi/`, `~/.claude/` — pi's sessions and settings, the Claude provider's
  transcripts.
- `<workspace>/.pi/`, `<workspace>/.mcp.json`, `<workspace>/.phosphor/`.
- MCP OAuth tokens. The adapter owns those in the OS credential store, and the
  keychain ACL binds to `pi`, not `Phosphor.app`.

The only bundle-internal thing read at runtime is `process.resourcesPath/pi-ext`,
the shipped extension sources, which the new version _should_ replace.

One consequence that is inherent: **an in-flight turn is lost on restart.** pi
writes a session file only when a turn ends. Finish the turn first.

### TCC grants survive an update

macOS privacy (TCC) records the app's **designated requirement** beside every
"Allow" you click and re-checks it on the next launch. A plain `codesign
--sign -` derives that requirement from the code hash, which changes every
build, so every auto-update would invalidate every grant and re-prompt for
Downloads / Documents / Desktop. With a release on every green merge, that is
roughly daily.

[scripts/adhoc-sign-mac.mjs](../scripts/adhoc-sign-mac.mjs) therefore signs with
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
`mac.extendInfo` in [electron-builder.yml](../electron-builder.yml) supplies the
`NS*FolderUsageDescription` strings so the dialog says why.

## The state machine

[electron/updates/update-state.ts](../electron/updates/update-state.ts) is a
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
