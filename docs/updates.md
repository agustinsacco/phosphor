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

Desktop and This Mac’s lane service update independently. Desktop and the PWA show the same step-by-step Software pipeline for a lane service or Host in Settings → Advanced. It reports a changed version as success, and a rollback as the version running now only when the updater's result says rolled back; a machine that comes back as a new instance on its old version without that result reads "restarted; the update didn’t finish", corrected to rolled back if the result arrives. A restart away for four minutes says it is still restarting and that a failed update rolls back on its own; at six minutes (the 180 s health wait, the rollback restart and a slow old start) it reads as not back, with **Reconnect**. The Desktop app’s own updater stays separate. [This Mac’s service](local-service.md) owns release gating, staged service updates and migration recovery.

After restarting a service, the Host updater gives the new version up to 180 seconds to become healthy before rolling back.

For a Host update with a job, Settings stays mounted if the connection drops after the job starts or after the client sees lanes begin to pause. A lost connection alone does not advance the pipeline to **Restart**: the job reports that it is applying the update, or the Host comes back as a new instance. If the same instance reconnects before the handoff, Settings resumes reads and the update continues from its previous step. If the updater hands off but the Host stays connected on the same version for four minutes, Settings shows that the update could not apply, resumes reading settings, and lets you try again.

## Three paths, chosen once at startup

`resolveUpdatePath()` in [apps/desktop/electron/updates/updater.ts](../apps/desktop/electron/updates/updater.ts)
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

On Linux, closing the final window asks before destroying its renderer
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

- `UpdatesFooter` (`features/updates/UpdatesFooter.tsx`, the sidebar footer on
  Desktop and the wide PWA; on a phone, the top of the Lanes page under the
  machine scope and of Home under All machines) has at most two fixed rows above the account row, each
  `name · text` with the full sentence in its tooltip. Desktop and each
  machine's service update separately, each with its own action; there is no
  combined action and no automatic update.
  1. `app`, only where the platform has `appInfo`: **Desktop · Downloading 42%**,
     **Installing…**, **Restart to update** (restarts) or **Download update**
     (opens the release page). Idle, checking and unsupported show nothing.
  2. `machine`: the machine in scope (This Mac's service in service mode, or the
     Host in scope; nothing for in-app This Mac or All machines). **Update
     available**, then the running pipeline's steps (**Downloading update…**,
     **Waiting for 2 turns**, **Restarting…**), then **Updated to X** for 8
     seconds or **Update didn’t finish**, which stays until that machine's
     Software row has been shown. The row never starts an update: it opens that
     machine's Settings → Advanced, where the one confirm lives. While an update
     runs on any machine, that run holds the row until it ends, whatever the scope;
     a running update comes before another machine's held result. A rollback or
     failed apply the Host reports that no update tracked here accounts for (a
     reload mid-restart, or an update started elsewhere) shows once as **Update
     didn’t finish**, in this row and the Software row, within the result's 24
     hours; each result counts once, by its version and finish time, and an update
     tracked here owns only a result from its own version to its target (one
     still running may own any target before it knows one). A later,
     newer release is offered again once a finished update's result has been
     shown (**Updated to X** keeps its 8 seconds); Software keeps a failure's
     explanation above the offer.

  Availability comes from the Host's own report (`machine.status` `data.update`,
  [host.md](host.md#updating)), which offers exactly what that Host's updater
  installs, Intel Mac Hosts included; a Host without one falls back to a newer version
  running on another of your machines. The rows never jump or flicker: nothing
  shows for the first 3 seconds after the app starts (a sidebar reopened later
  shows its rows at once); "Update available" appears only after a successful
  read and 3 seconds of the machine being ready (each machine's readiness and
  the rows' timing live in `stores/machineUpdates.ts`, so a remount continues
  them; expiry is worked out from the stored times, and an offer that expired stays
  expired, through a brief reconnect, another drop or a remount, until a fresh
  status read), survives a disconnection for up to 10 minutes, stays through a
  reconnect until a status read on the new connection answers, and leaves only
  when a status checked later than the offer (`checkedAt`) says current, or the
  scope changes; each phase shows at least 600 ms, collapsing included, but only while its
  action stays the same: a new action (another machine, or **Restart to
  update** becoming **Download update**) shows its own label at once, so a
  label always says what a click does; a scope switch waits 150 ms before
  collapsing. A machine removed from the account leaves the rows. Each row is 28 px and its height
  animates in 200 ms (none under reduced motion), so the account row never moves.

- Settings → About and This Mac's Settings → Advanced have **Check now** (one
  shared row, `useAppUpdate`), the way to ask "am I current?" while the app row
  is hidden.
