# The Host

The Host is Phosphor's plain-Node application for machines Desktop does not run
on. Its command is `phosphor`; its config and logs live in `phosphor-host`
folders, apart from Desktop's own. `setup` writes its config. `doctor` checks
whether a machine can run sessions, `providers` which models pi can use there,
and `accept` runs real sessions to prove it ([accept](#accept)). `login`,
`status` and `logout` manage its machine identity in the control plane. `run`
sends heartbeats; `service` runs it as a Linux systemd user service or a macOS
LaunchAgent. It listens only on loopback for grant-authenticated clients
([API](#api)). `npm run build:host` builds it
([Build](#build)); signed releases carry their own pinned Node runtime. Desktop never runs a
Host, and offline Desktop never needs one
([remote-access.md](remote-access.md)).

The source is `apps/host/src/`. It imports Node builtins and the exported
subpaths of `@phosphor/session-runtime` and `@phosphor/shared`, plus `ws`:
ESLint refuses Electron, `@shared/*` and `@/*`, and `boundary.test.ts` checks
every library import against the package's exports.

## Setting up a Host

### Install from a release

This repository builds signed bundles, manifests and an installer for Linux x64,
Linux arm64 and macOS arm64. The manual **Host Release** workflow
(`.github/workflows/release-host.yml`, run from main with a version higher than
every published one, after main's CI passed for that exact commit) builds all
three, signs the manifest with the `HOST_RELEASE_SIGNING_KEY` secret, verifies the
signature against the pinned keys, and publishes `host-v<version>`. It then
replaces the unversioned manifest, its signature and the installer on the rolling
`host-latest` release. Neither release is marked latest, so Desktop keeps
`releases/latest`. The workflow refuses to build while `HOST_RELEASE_KEYS` is
empty, and an installer with no keys refuses installation. Each bundle carries Node 24.14.1, so no system Node is needed.
The installer needs curl, ssh-keygen, tar, awk, base64, od and sha256sum or shasum.

```sh
curl -fsSL https://github.com/agustinsacco/Phosphor/releases/download/host-latest/install.sh | sh
```

The generated installer verifies the manifest's OpenSSH Ed25519 signature in
namespace `phosphor-host-release` against embedded pinned keys. It then checks
the selected tarball's byte count and SHA-256 before extracting it. With no
version argument, it reads the signed manifest from the rolling `host-latest`
release and downloads the artifact from the signed version's `host-v*` release.
Host releases never replace Desktop's latest release. To pin a version, save
`install.sh` and run `sh install.sh X.Y.Z`. `PHOSPHOR_HOST_RELEASE_URL` overrides
the asset folder for an offline mirror (`file://` works too).

Programs live in `~/.local/lib/phosphor-host/versions/<version>/`. An atomic
symlink replacement selects `current`; `~/.local/bin/phosphor` points at its
launcher. Add `~/.local/bin` to PATH, then run `phosphor setup`. A failed
verification leaves an existing install untouched. Config, identity, state and
provider installs are never changed. An already selected version with a matching
`VERSION` is idempotent: the installer verifies the signed manifest, keeps the
version folder untouched and makes sure the launcher is in place. Any other
existing version folder is refused, with an instruction to run
`phosphor update --rollback` or remove that folder before trying again.
Use `phosphor update` to select another signed release. A `current` that is not
a symlink is refused.

A launcher symlink is ours only when it points exactly at
`~/.local/lib/phosphor-host/current/bin/phosphor`. A different launcher is refused
unless `--replace-launcher` is passed. That flag keeps a user-owned file or
symlink as `~/.local/bin/phosphor.before-release`; an existing backup or a
directory at the launcher path is refused. If a Host service is already running,
run `phosphor service install` again after replacing its launcher.

The installer uses `~/.local/lib/phosphor-host/.install-lock/`. Any updater must
follow this same protocol. Acquire it with mkdir, then write the owner's positive
decimal process id followed by a newline into `pid`. A live owner refuses another
installer. A missing or malformed pid is refused too: its owner may still be
writing it. Remove a refused lock only if no install or update is running.

To reclaim a dead owner's lock, take the `recovery/` mkdir gate inside it,
re-read the pid and require that it is unchanged and still dead. Retire the whole
lock by renaming it to `.install-lock.retired.<own-pid>` before deleting its known
contents (`pid`, `recovery/`) and the folder. The gate moves with the lock, so a
second reclaimer cannot delete a new owner's lock. Try acquisition only once
more. Owners also retire their locks by rename on exit; no program deletes the
lock path in place. Cleanup releases only its own gate, retired folder or lock.
Acquisition sweeps at most 16 exact, non-symlink retired folders whose pid is dead.

HUP, INT and TERM are deferred during lock acquisition, reclamation and
same-filesystem publication renames, never discarded. Outside those sections,
they exit immediately. A signal during publication finishes a consistent install
(or rolls back a failed step), cleans up and exits 129, 130 or 143 without a
success message. Critical lock and publication children ignore those signals so
their mkdir and rename status is reliable. Rollback checks the filesystem too, restores `current` and
the launcher before deleting an unselected new version, and keeps the complete
bundle and any backup if restoration fails. It then tries to select the new
bundle and prints that installation may have completed and rerunning is safe.
If that also fails, it deletes neither bundle. A completed install is idempotent
on rerun. SIGKILL or power loss can leave a pid-less lock or an abandoned
`.install-lock/recovery` gate. Both require manual removal after confirming no
installer or updater is running; the refusal message names `.install-lock`.
A dead owner's lock with a pid and no recovery gate is reclaimed on the next run.

### Install from source

Build from source on the execution machine with Node 22.19 or newer and git:

```bash
git clone --depth 1 https://github.com/agustinsacco/phosphor.git ~/src/phosphor
cd ~/src/phosphor && npm ci --ignore-scripts
npm run build:host -- --out "$HOME/.local/share/phosphor-host"
node "$HOME/.local/share/phosphor-host/phosphor.mjs" help
```

For a source install, use `node "$HOME/.local/share/phosphor-host/phosphor.mjs"`
in place of `phosphor` in the commands below. `service install` pins the running
Node executable, bundle and config paths. Keep that Node installation and source
bundle available to the service. Release installs supply their own launcher and
pinned Node. Copying a build made elsewhere ([Build](#build)) works too.
Desktop's Add a machine dialog offers the signed release installer and manual setup.

Continue with [Bring a machine online](remote-access.md#bring-a-machine-online)
for setup, provider sign-in, acceptance, enrollment, Tailscale and service startup.
The command reference below owns each command's detailed behavior.

## setup

`setup` is non-interactive. Repeat `--repository DIR` for up to 64 directories.
Relative paths resolve from the caller's cwd. Each directory must exist and
must not resolve to `/`, the home directory, or a folder containing the home
directory. A non-git folder is accepted with a note. With no directory flag,
setup uses `git rev-parse --show-toplevel`; outside git it exits 64 with an example.

`--pi FILE` pins that path, otherwise the first pi on the caller's PATH. A found
program keeps its own name, so symlinks and shell wrappers stay pinned as found,
but its folder is resolved to its real path: version managers put per-shell links
on PATH (fnm's multishell folder under `/run/user` is gone at logout), and a
config must outlive the shell that wrote it. The same applies to a found node and
to the Claude and git folders below. A Node script needs `--node FILE`, or node
beside the found pi, or node on PATH, in that order.
A direct executable needs no node. Missing pi exits 69 with its npm install
command. Claude and git directories absent from the Host's built PATH are added
to `environment.path`, without duplicates. Missing Claude is fine; missing git
is noted. No environment values other than paths are printed.

Setup validates the candidate and runs doctor's pi resolution before writing.
Failed checks exit 69 or 78 and write nothing. An existing valid config is
summarized and left untouched, with exit 0. An invalid one is left untouched
with safe errors and exit 78. `--replace` rewrites it, keeping `hostId`,
`contextBudget`, `environment.pass`, `accounts`, `control`, `api.port` and `resourceRoot`
when the old config loads and validates. Other settings are detected again;
`autoNameLanes` and `allowRepositoryChanges` return to their default `true`.
A broken old file is replaced with a note. A symlink is replaced, never written through.

The new directory is 0700 and the new file 0600. An existing directory must
belong to the caller and not be writable by others; otherwise setup exits 78
and names the problem. A writable-directory error gives the `chmod` to run.
The JSON file is written to an exclusive temporary file and synced, then
published atomically and loaded again. First setup uses a hard link so it cannot
overwrite a config that appeared during detection; that race exits 75 and asks
you to rerun setup. A filesystem without hard links fails with exit 70, without
falling back to overwrite. `--replace` uses rename instead. The temporary file
is removed on success and failure. A failed post-write load exits 70. Text and
`--json` show the config, pi and node paths and versions, repositories, Claude
presence, extra PATH and notes, ending with `next: phosphor doctor` on success.

## Commands

```
phosphor setup [--repository DIR]... [--pi FILE] [--node FILE] [--replace]
               [--config FILE] [--json]
phosphor doctor [--config FILE] [--json]
phosphor providers [--config FILE] [--json]
phosphor providers login PROVIDER [--config FILE]
phosphor accept --repository DIR [--lane native|claude|all] [--keep-transcripts]
                [--model ID [--provider NAME]] [--claude-model ID]
                [--config FILE] [--json]
phosphor login [--config FILE]
phosphor status [--config FILE] [--json]
phosphor logout [--config FILE] [--local]
phosphor run [--config FILE] [--supervisor launchd]
phosphor service install|status|restart|logs|uninstall [--config FILE]
phosphor service logs [--config FILE] [--follow]
phosphor tailscale status|enable|disable [--config FILE]
phosphor update [--version X.Y.Z] [--check] [--json]
phosphor update --rollback [--json]
phosphor uninstall [--purge --yes] [--json]
phosphor version [--json]
phosphor help
```

`--help` also prints usage.

stdout carries only the report or the JSON. Usage errors and accept's progress
go to stderr.
`version` prints the independent Host release version, or `0.0.0-dev.<sha7>`
for dev builds (`0.0.0-dev.source` when no commit is stamped).

| Exit          | Meaning                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------ |
| 0             | success                                                                                          |
| 1             | an acceptance check failed; its transcript is kept                                               |
| 64            | usage error                                                                                      |
| 69            | a prerequisite is unavailable; for `providers`, nothing is signed in; for `status`, not enrolled |
| 70            | internal error, a failed cleanup or the drain deadline                                           |
| 75            | control plane unreachable, invalid response, enrollment code expired or concurrent setup         |
| 77            | this machine is removed from the account                                                         |
| 78            | the config or state storage is invalid                                                           |
| 129, 130, 143 | ended by SIGHUP, SIGINT or SIGTERM, after stopping probes and sessions                           |

## Build

`npm run build:host` writes `apps/host/dist/`, which git ignores. It runs
`node apps/host/scripts/build.mjs`, which also takes `--out DIR` and `--sha SHA`:

- `phosphor.mjs`: one ESM file for Node 22, built by esbuild from `src/main.ts`.
  Dev builds also carry a linked source map. Release builds have no source map
  or `sourceMappingURL`. Run it as `node phosphor.mjs <command>`.
- `pi-ext/`: the bundled extensions, copied with Desktop's filter (every `.ts`
  file but tests). A session loads them from beside the bundle unless the config
  sets `resourceRoot`.
- `skills/visual-artifacts/`: the same authoring skill and references Desktop
  ships. `accept` and usable `run` startup seed a user-owned copy in pi's skills
  directory before starting sessions. Edits and deletion survive later runs; `doctor` never installs
  it. See [the shared lifecycle](extensions.md#the-artifact-tools-and-what-each-one-costs).
- `BUILD-INFO.json`: the version, the source commit, whether the tree had
  uncommitted changes, the Node target, and every file with its size and sha256.

Release builds take strict `X.Y.Z` from `HOST_RELEASE_VERSION` and ignore
untracked files when computing `sourceDirty`. Otherwise the
version is `0.0.0-dev.<sha7>` of the source commit, HEAD unless `--sha` names
another. The build fails if the bundle reaches Electron, `electron-store`,
`electron-updater`, a direct `node-pty` import, Desktop or the site, imports anything but a Node
builtin, or lacks one of the six extensions. It only replaces an empty folder or
an earlier build: a real folder whose `BUILD-INFO.json` is a regular file naming
`phosphor`, schema 1, that lists every other file in it. Anything else, a link
inside included, is refused and left alone, and the check is repeated just
before the replacement. The build runs in a new folder beside the output
(`apps/host/scripts/output.mjs`). At the end the earlier build is moved aside,
the new one moved in, and the earlier one deleted only then; if the new one
cannot take its place, the earlier one is moved back. A failure removes only the
new folder and leaves the output as it was, with one exception: if the earlier
build cannot be moved back either, the output is gone and the build names the
folder beside it that holds the earlier one. An earlier build that cannot be
deleted once the new one is in place is left beside the output, possibly in
part, and the build names it. A build killed outright can leave a
`.phosphor-build-*` folder. `tools/host-release/build-bundle.mjs --target TARGET --out DIR` wraps that
build with the Node archive pinned in `tools/host-release/node.json`. It checks
the committed SHA-256 on download and on cache reuse. Its sorted ustar entries
have fixed timestamps, owners and modes; repeated builds of the same tree on
one platform are byte-identical. The archive includes Node and its license,
`lib/` with the Host and its resources, `VERSION`, and a POSIX launcher that
resolves symlinks without `readlink -f`.

After all three targets are built, `tools/host-release/manifest.mjs --out DIR`
writes a manifest with version, protocols, pinned Node version, source commit,
and each artifact's target, file, bytes and SHA-256. It signs the exact bytes
with `ssh-keygen -Y sign`, namespace `phosphor-host-release`, hash `sha512`.
`HOST_RELEASE_SIGNING_KEY` supplies an OpenSSH Ed25519 private key, never a
path. A 0600 temporary key file is removed on success and failure. The public
keys have one source, `HOST_RELEASE_KEYS` in `libs/shared/src/host-release.ts`;
the builder generates `install.sh` from those keys. Host's release verifier
uses Node crypto to verify SSHSIG and parse the bounded manifest before an
artifact's size and hash are checked.

`bundle.test.ts` builds into a scratch folder and checks `BUILD-INFO.json`
against the files, the imports, and `pi-ext/`, and that a folder that is not an
earlier build is refused and left as it was. It then runs the built file under a
minimal environment (`HOME`, `USER`, `LOGNAME` and `PATH=/usr/bin:/bin`):
`version`, `doctor` on the extensions beside it, and `accept` on a fake pi.
Another `accept` gets SIGTERM in the middle of a turn: it exits 143, pi's group
is gone, and the aborted turn is saved. A second signal during a drain forces
it. An `accept` whose pi leaves a process holding its pipes exits 70 once its
stop's 20 s pass, rather than wait on that process. `output.test.ts` covers the
replacement itself, with renames and deletions that fail.

## Updating

Release installs support `phosphor update`, `phosphor update --check` and
`phosphor update --version X.Y.Z`. Add `--json` for a machine-readable result.
Source installs print the release installer command instead. One release key
is pinned in `HOST_RELEASE_KEYS`; its private half exists only as the
`HOST_RELEASE_SIGNING_KEY` repository secret. To rotate, append the new public
key, publish a release signed with the old one, then switch the secret.

The updater verifies the signed manifest before reading its metadata, refuses
a downgrade and checks this machine's artifact and protocol. A release must
speak this Host's protocol or a newer one: a newer protocol is how a Host catches
up with apps that already updated. When the release drops this Host's current
protocol, `update` and `--check` say that apps which have not updated cannot
connect, and `update --rollback` undoes it. `--check` reports
installed and available versions without downloading the bundle. The
`PHOSPHOR_HOST_RELEASE_URL` override is one flat asset folder for the manifest,
its signature and the artifact, just like the installer. An empty override is unset.
Only HTTPS and offline
`file://` mirrors are accepted; redirects stay on HTTPS and stop after three.

Downloads have byte caps and a 30-second inactivity deadline. The bundle must
match its signed byte count and SHA-256 before a built-in ustar reader expands
it. Expanded bytes, including headers and padding, stop at 256 MiB; at most
4,096 regular-file entries with the installer's path rules are accepted. Links,
devices, traversal, corrupt or truncated archives and a mismatched `VERSION`
are refused. A failure before selection removes staging and keeps `current`.
Update, rollback and uninstall use the installer's shared lock and defer signals
through synchronous publication. SIGKILL or power loss can still require the
manual lock recovery described above.

Selection atomically replaces `current` and records current and previous
versions in `install.json`. It retains those two and at most one other valid
installed version. Service installs on Linux and macOS point node and the bundle through
`current`, so a service survives a version change. Reinstall a service created
before this rule with `phosphor service install`.

An active Linux service or loaded macOS LaunchAgent restarts after selection.
The updater waits up to 90 seconds for a new run's accepted heartbeat. `run`
writes `{ version, pid, startedAt, acceptedAt }` to `<state>/run.json` atomically
at 0600 after its first accepted running heartbeat and at most once a minute.
If the new version is not healthy, update selects the old version and restarts
it again, then exits 75. A normal update without a running service asks you to
restart `phosphor run`.
`phosphor update --rollback` selects the recorded previous installed version
without network access; an installed service is restarted and health-checked even
if it is stopped. Rollback is the updater's only downgrade path.

## Uninstalling

`phosphor uninstall` uninstalls the user service and removes a release program.
A running service is stopped even if its unit file or plist is missing. On Linux,
a service that stays active leaves the program in place and exits 75.
It removes `~/.local/bin/phosphor` only if that symlink points exactly at the
release's `current/bin/phosphor`. A foreign launcher and
`phosphor.before-release` stay untouched. Source installs print the bundle
folder to delete instead. Config, identity, state and provider data stay in
place, and the command prints the config and state directories. Add `--json`
for a machine-readable result.

`phosphor uninstall --purge --yes` first logs out remotely and only on success
removes the default config and state directories too. Both flags are required.
A failed logout keeps the program, service and data and exits 75. Every directory
removed is checked for ownership, its expected location and symlinked ancestors.
pi's sessions and provider credentials are never removed.

## Config

The file is `--config FILE`, else `${XDG_CONFIG_HOME:-~/.config}/phosphor-host/config.json`
on Linux and macOS alike. A relative `XDG_CONFIG_HOME` is ignored. No environment
variable directly names the config file.

```json
{
  "version": 1,
  "hostId": "bee1",
  "pi": {
    "node": "/home/me/.local/share/fnm/node-versions/v24.14.1/installation/bin/node",
    "executable": "/home/me/.local/share/fnm/node-versions/v24.14.1/installation/bin/pi"
  },
  "repositories": ["/home/me/src/phosphor"],
  "contextBudget": "",
  "environment": { "pass": ["GH_TOKEN"], "path": ["/home/me/.cargo/bin"] },
  "accounts": null,
  "control": { "url": "https://phosphor.saccolabs.com" }
}
```

- **Strict.** Plain JSON up to 64 KiB with `version: 1`. Unknown keys are
  refused at any depth, and every problem is reported at once with its JSON
  pointer. A syntax error reports only its position, so a value pasted into the
  file by mistake is never echoed back.
- **Owner-only.** The config pins which programs run, so the file, its folder
  and (through a symlink) the real file's folder must belong to the user running
  the Host and must not be writable by group or others. doctor prints the
  `chmod` to run.
- **Pinned paths.** Every path is absolute and normalized. `~` is not expanded.

| Field                    | Meaning                                                                                                                                                                             |
| ------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `version`                | Required, exactly `1`.                                                                                                                                                              |
| `autoNameLanes`          | Optional boolean, default `true`. Enables Host-generated lane names.                                                                                                                |
| `allowRepositoryChanges` | Optional boolean, default `true`. Allows home-relative folder browsing and repository registration/removal.                                                                         |
| `api.port`               | Optional integer from 1024 to 65535, default 47615. Loopback and Tailscale Serve port.                                                                                              |
| `hostId`                 | Optional. Defaults to the short hostname, made to fit the HostHello identifier pattern.                                                                                             |
| `pi.executable`          | What `command -v pi` prints.                                                                                                                                                        |
| `pi.node`                | The node that runs pi. Required when `pi.executable` resolves to a Node script, as an npm-installed pi does.                                                                        |
| `resourceRoot`           | Holds `pi-ext/` and `skills/`. Defaults to the running bundle's own folder.                                                                                                         |
| `repositories`           | 1 to 64 folders that sessions may run in. Never `/`.                                                                                                                                |
| `contextBudget`          | Desktop's grammar; `""` or absent is the 200k default. A value Desktop would quietly replace with the default, such as `77k`, is an error.                                          |
| `environment.pass`       | Up to 64 more variable names for pi. Names only, never values. Naming `PATH` or a hook below is an error.                                                                           |
| `environment.path`       | Up to 32 more PATH folders.                                                                                                                                                         |
| `control.url`            | Optional bare origin. Defaults to `https://phosphor.saccolabs.com`. HTTPS, or HTTP only on localhost, 127.0.0.1 or ::1. No credentials, path, query or fragment. Ports are 1-65535. |
| `accounts`               | `null` or absent: accounts are unavailable on a Host.                                                                                                                               |

## Machine identity

`phosphor login` prints an approval code and the new key's fingerprint. In a
signed-in Desktop, open Machines > Add a machine, enter the code, compare the
fingerprint, and approve. It works without a terminal, including over plain
SSH. Each new enrollment has a fresh Ed25519 key. Polls wait the server's
interval. Transient failures retry with exponential backoff capped at 30 seconds,
without waiting past the code's deadline. Enrollment ends within 10 minutes.
An expired code exits 75. Ctrl-C while waiting exits 130 and keeps the pending
request. Run login again within the code's lifetime to resume with the same code
and key, even if Desktop already approved it.

An already enrolled and confirmed machine exits 0 without replacing its identity.
Login removes any leftover pending request. A removed
machine starts a new enrollment, or resumes the pending one, keeping the old
identity until the new one is approved; approval then removes the old pair
before saving the new one. Approval saves the identity, then checks it
once with the server. If that check cannot finish, the identity stays saved
and login exits 0 with a hint to run status. A 410 removes the new identity
and exits 77.

The files live in `identity/` beside the config file, including when
`--config FILE` names another config. The directory is 0700; files are 0600:

- `host.json`: `{version: 1, controlUrl, hostId, label, ownerLogin, savedAt}`.
  `hostId` is the enrolled UUID, not the config's local name. `savedAt` is the
  Host's clock. The server supplies `enrolledAt` in status.
- `host-key.<hostId>.pem`: the private key, PKCS#8 PEM. It never leaves the Host.
- `pending-key.pem` and `pending.json`: the pending key and
  `{version: 1, controlUrl, enrollmentId, userCode, keyFingerprint, expiresAt, savedAt, pollIntervalSec}`.
  Login saves the key first, then the metadata, before printing the code.
  Approval commits the identity before removing these files. Expired, invalid or
  other-origin pending requests are discarded on the next login.
- `.lock`: the pid, random ownership token and start time of a login or logout.
  A complete, synced temporary file is linked atomically into place. A live pid
  refuses another login or logout with exit 75. Dead or invalid locks are
  reclaimed under the `.lock-recovery` directory gate. A gate is waited on for
  at most one second, then exits 75. Only the process that created a gate
  removes it: a gate over 30 seconds old indicates a possible crash, and the message
  asks you to remove it if no login or logout is running. Release uses the
  same gate and removes only its own token. Recovery compares the file identity
  and token again under the gate. A symlink is removed without touching its
  target; a directory at `.lock` is refused with a removal instruction. The main
  lock has no age timeout.
  Status stays read-only and does not take the lock.

Login and logout hold the identity lock for their entire operation. Logout
removes local state only if the identity still names the machine it revoked.
Both successful logout and `logout --local` also remove pending requests.

A save atomically renames the new key first, then `host.json`, the commit
point, then removes obsolete keys. A failure before the commit keeps the
old pair usable; a stopped save can leave an unused key. Login can reuse an
orphan key when it is byte for byte the pending key and no `host.json` exists. Loads read metadata
first and refuse links, non-files, another owner's files, group or other
permissions, and files over 4 KiB. A missing or refused key is an incomplete
identity: fix its permissions or run login to enroll again.

The saved origin binds the identity. If config points elsewhere, login,
status and plain logout exit 78 without contacting either origin. Run
`phosphor logout --local`, then login, to change it.

`phosphor status` shows the local identity and the server's label, owner,
enrollment time and last seen. It exits 0 when confirmed, 69 when not enrolled,
77 when removed, 75 when unreachable or the response is invalid, and 78 for
invalid storage or config. `--json` is one object with this stable shape:

```json
{
  "version": 1,
  "status": "confirmed",
  "identity": {
    "version": 1,
    "controlUrl": "https://phosphor.saccolabs.com",
    "hostId": "0b6f7c1e-2f4a-4c8e-9d1b-5a7e3c2f1d00",
    "label": "bee1",
    "ownerLogin": "me",
    "savedAt": "2026-10-10T00:00:00.000Z"
  },
  "server": {
    "hostId": "0b6f7c1e-2f4a-4c8e-9d1b-5a7e3c2f1d00",
    "label": "bee1",
    "owner": { "login": "me" },
    "enrolledAt": "2026-10-10T00:00:00.000Z",
    "lastSeenAt": null
  },
  "error": null
}
```

`status` is `confirmed`, `not-enrolled`, `removed`, `unreachable` or `invalid`.
`identity` and `server` are null when unavailable; `error` is null or a safe
message. No key, signature or headers appear in the report.

`phosphor logout` signs a revoke and then forgets the local identity. Not
signed in, successful revoke, or already removed (410) all exit 0. An
unreachable server exits 75 and keeps the identity, with the `--local` hint.
`--local` never contacts the server and works even if config is invalid. It
forgets the files only; the machine stays listed until removed in Desktop.

Login, status, logout, run and service status contact the configured control
plane. Enrollment sends the public key, hostname, platform, architecture and
Host version. Status, logout and run send the enrolled UUID. Heartbeats send
readiness and the Host version, with zero lane counts and the verified Tailscale
endpoint, or null when no safe route is available (see [Tailscale](#tailscale)).
Requests carry a timestamp, random nonce and Ed25519
signature. No repository names, paths, transcripts or provider tokens
are sent to control. Authorized Desktop clients read lane content directly through
the separate Host API. Redirects are refused. Requests time out after 10 seconds;
responses are capped at 64 KiB and validated with the shared wire contract.

## State

`phosphor run` opens `${XDG_STATE_HOME:-~/.local/state}/phosphor-host/state.sqlite`
after taking the run lock. Relative `XDG_STATE_HOME` is ignored. The folder is
0700 and the database is 0600. Symlinks, another owner's storage and group or
other permissions are refused. A newer schema exits 78; other open failures
exit 70 and name the folder.

The SQLite WAL database holds repositories, stable lane ids, control fences and
controllers, attention and read counters, and request receipts. On start, run
reconciles pi's session files against the lane index and marks interrupted
requests as unknown. Unavailable configured repositories become inactive, with
one count-only log line; they do not stop heartbeats. Their ids stay stable when
the folders return. Run scans active repository roots, up to 256 direct worktree
folders per repository, and live lanes' folders. Worktree links and folders
outside the repository are skipped. Removed lanes are kept for 30 days, with at
most 1000 removed rows after reconciliation. A returning session file keeps its
lane id until that row is pruned. Vanished files are removed before new files
are admitted, so replacements can be indexed in one scan even at capacity.
Corrupt lane and repository rows are skipped on reads and logged only by count;
reads do not repair or delete them.

Finished receipts are kept for 24 hours from completion, with at most 10000
finished rows. After that lifetime a finished request id can be admitted as new.
Unfinished requests survive pruning; at 10000 unfinished rows the store refuses
new requests as busy. Receipt reads never reveal another client's request. A
rejected receipt keeps its historic controller and fence, but computes that
controller's connection state at read time. While a corrupt receipt is retained,
it is logged only by count and treated as unknown, never admitted again.
Uninstall keeps State. Transcripts stay in
pi's own session files; the database never copies their messages.

## Commands and control

`lanes/commands.ts` checks authenticated clients' lane mutations, records each
request before acting, and returns a durable receipt. Repeats return the recorded
receipt or `pending`, never run the operation again. Request id conflicts are
refused. Each lane serializes checks, admission, control publication and dispatch,
not pi completion. A dialog reply or abort can dispatch while a prompt or compact
is unanswered. pi sees dispatched operations in the runtime's order, as on Desktop;
the runtime may await `get_state` before writing a prompt. Resume and stop hold the
queue until completion or their deadline. Different lanes run concurrently.
The per-lane limit of 32 counts queued, in-flight and timed-out operations whose
runtime promises have not settled. A late settlement frees its slot.
If recording a terminal receipt fails, it is still delivered, but receipt status
stays `pending` until a Host restart marks it `unknown`.

[Protocol control and receipt rules](remote-protocol.md#frames-and-streams) own
controller fences, takeover/release, client-scoped results and uncertain outcomes.
The Host persists the fence before publishing control. If publication fails, the
next queued operation republishes fresh stored control before dispatching. A
takeover or release still returns `done` for its durable change; another operation
whose admission publication fails returns `failed internal` without dispatching.
The [API](#api) dispatches authenticated commands through this pipeline.

## API

`phosphor run` listens on `127.0.0.1:47615` only, once an accepted heartbeat
supplies the enrolled owner and epoch. `api.port` in config sets an integer
from 1024 to 65535. A busy port logs `api.unavailable` and retries every minute;
heartbeats continue. [Tailscale Serve](#tailscale) exposes the loopback endpoint on the
tailnet. The Host does not listen directly on a Tailscale address or use Funnel.

`GET /v1/hello?challenge=<64 lowercase hex>` returns the Host hello and an
Ed25519 proof over the Host id, runtime epoch and challenge. It is unauthenticated,
uncached and limited to ten requests per second. `/v1/stream` upgrades to a
WebSocket. Only GET is accepted. Host headers must name localhost or 127.0.0.1
with the configured port, or a `.ts.net` name. Any Origin header is refused.

The first text frame must be `auth {grant, challenge}` within ten seconds.
[Grant verification](remote-protocol.md#host-grants) and
[connection authorization](remote-access.md#connect-and-authorize) own signature,
identity, proof and renewal rules. The API caches control public keys, refreshing
hourly and on an unknown key id at most once per minute. A failed refresh keeps
the old set. Expiry closes at `exp + 60 seconds`, matching clock skew. Heartbeat
revocations close matching sockets; changed owner/epoch or removal closes all
sockets. Missing heartbeat fields do not erase authority or revocations.

With a usable machine, hello announces `sessions.read`, `sessions.control`,
`workspaces.read`, `workspaces.write`, `skills.read`, `artifacts.read` and `routines`.
It also announces `terminal` when native PTY loading succeeds.
The adapter routes lane subscriptions, read calls and receipt-backed commands,
including creation. Without a lane service, no capabilities are announced;
subscriptions and commands are forbidden and calls are unsupported.
[Protocol capability rules](remote-protocol.md#frames-and-streams) separate lane
and terminal subscriptions and gate each call on its operation's capability.
Command admission uses each operation's required capabilities, not a universal
`sessions.control` check. Feature sections below specify the additional checks.

[Protocol bounds](remote-protocol.md#frames-and-streams) own frame, subscription,
command, call and receipt-interest limits, deduplication and result sizing.
The API adapter publishes controller presence on a client's first ready socket
and last close, without changing the lane fence.

Client protocol pings receive pongs. WebSocket control pings keep the transport
alive but do not reset the 60-second text-frame idle deadline. There are at most
64 sockets and four per
client. Up to 16 excess sockets get a close frame, then further upgrades get
HTTP 429. Closing sockets count until closed or terminated after two seconds.
At most 80 TCP sockets are accepted, including sockets that have not upgraded.
HTTP headers and requests time out after ten seconds, checked each second.
Drain closes upgraded sockets and destroys remaining TCP sockets before releasing
the run lock.

[Protocol close codes](remote-protocol.md#frames-and-streams) distinguish malformed
frames, auth failure, forbidden access, incompatible versions and overload.

API logs contain fixed event and operation names, outcome classes, validated
connection traces, close codes, durations and ports, never client or lane ids.
They never contain grants, signatures, challenges, proofs, keys or header values.

## Tailscale

`phosphor tailscale status|enable|disable [--config FILE]` manages only the
configured `api.port` (default 47615). The API still listens on loopback only.
The Host finds `tailscale` on its PATH, then in fixed install locations when the
service PATH omits it (macOS: the Tailscale.app bundle, `/usr/local/bin`,
`/opt/homebrew/bin`; Linux: `/usr/bin`, `/usr/local/bin`, `/snap/bin`).
`status` shows the route state, the endpoint the Host reports, and the next step.
It exits 0 for the Host's route and 69 otherwise.

`enable` runs exactly:

```bash
tailscale serve --bg --https=47615 http://127.0.0.1:47615
```

Both ports follow `api.port` when configured. The route persists in tailscaled
across reboots. An already enabled route is left alone. `disable` runs
`tailscale serve --https=47615 off` only for that exact Host route. An absent
route is already disabled. Both changes require a verified status readback.

On Linux, a nonzero serve exit may need the one-time fix
`sudo tailscale set --operator=$USER`. Phosphor prints that hint; it never runs
sudo or changes the operator itself. A failed change or readback exits 75.
Missing or stopped Tailscale, or an unusable certified `.ts.net` name, exits 69.
An unverifiable route is not changed.

The Host never uses Funnel. A Funnel route on this port would publish the Host
to the internet and must be turned off. Funnel, a different proxy target, extra
path handlers, HTTP or a TCP forwarder cause enable and disable to refuse with
exit 78. The Host refuses to replace a different route. Routes on other
ports are left alone. `doctor` warns about an absent route and fails for Funnel
or another route on this port. `setup` only suggests `phosphor tailscale enable`
when Tailscale is running with a usable certified name and the route is absent;
it never changes serve config.

At start and every five minutes, the readiness refresh verifies the running
machine's certified `Self.DNSName` and serve config. Only an HTTPS route with
one `/` handler proxying exactly to `http://127.0.0.1:<api.port>` and no Funnel
produces the heartbeat endpoint `https://<machine>.<tailnet>.ts.net:<api.port>`.
The endpoint is null for any other route, invalid name, missing certificate
domain or failed probe. Logs record changed route states only, never Tailscale
names, addresses or output.

## Running as a service

After `phosphor login`, `phosphor run` reports the machine's readiness to the
control plane every 30 seconds, or the interval the server returns, plus up to
3 seconds of jitter. pi, Claude sign-in and Tailscale are checked at start and
every five minutes. Each probe has a 2 second deadline and a 64 KiB output cap.
Readiness probes do not start sessions. The daemon also serves interactive lanes
and runs acknowledged routines. Logs record each control call and state change,
with no keys or signatures.

Only one run holds `identity/.run-lock`. It uses the identity lock's publication,
recovery and ownership rules, with its own `.run-lock-recovery` gate. It reads
identity under `.lock` and releases that lock before running. The persisted
sequence in `identity/heartbeat.json` is `{version: 1, hostId, seq}`, written
atomically with mode 0600 and synced before sending. Each new sequence is the
larger of the previous value plus one and the current time in milliseconds.
A file for another Host is replaced. Losing the file is safe while the clock
has not stepped back past the server's last sequence.

Network failures back off from 5 seconds to 5 minutes. A success resets the
backoff. Rate limits wait 10 seconds; a stale sequence retries with a fresh one.
A removed machine exits 77, keeps its identity and asks you to run login again.
SIGTERM or SIGINT sends one stopping beat, waits at most 5 seconds, and exits 0
whether or not that beat succeeds. A sequence write already running gets up to
1 more second to land, so the next run reads it. A second signal cuts the beat
and that wait short and exits with its own code, 130 for SIGINT. Either way it
first releases its run lock, waiting at most 3 seconds so recovery state is not
abandoned during shutdown. A signal during start-up stops reconciliation, closes the store and releases the
run lock before exiting, without sending a heartbeat.

On Linux, `phosphor service install` requires an enrolled identity and writes
`${XDG_CONFIG_HOME:-~/.config}/systemd/user/phosphor-host.service` atomically with
mode 0644. It pins the absolute node, bundle and config paths, quotes spaces and
escapes systemd specifiers. Control characters in paths or PATH are refused.
A `$` in the node executable path is also refused; install Node elsewhere.
Dollar signs in bundle and config paths are escaped as literal arguments.
The unit captures the shell's PATH, no other environment, with the node
executable's directory moved to the front: a version manager's per-shell entry
(fnm's multishell directory) is gone after logout, so node and the CLIs installed
beside it must not depend on it. Provider credentials
stay in pi's and Claude's stores. It restarts on failure after 10 seconds,
except exits 64, 69, 77 and 78, which require operator action.

Install reloads systemd, enables the unit and restarts it, which starts it or
applies a replacement, then enables linger for the current user so it survives logout
and reboot. If linger needs permission, the service stays running and the
command prints `sudo loginctl enable-linger USER` for you to run. It never runs
sudo itself. Reinstall replaces the unit and restarts it.

- `service status` shows ActiveState, SubState, MainPID, ExecMainStatus and
  linger, then the same machine summary as `phosphor status`.
- `service restart` restarts the unit.
- `service logs` streams the last 200 journal lines without a pager; `--follow`
  keeps streaming new lines.
- `service uninstall` stops and disables the unit, removes it and reloads
  systemd. It is idempotent and never touches identity, config or provider data.

On macOS, the same commands manage the per-user LaunchAgent
`~/Library/LaunchAgents/com.saccolabs.phosphor-host.plist`. Install requires an
enrolled identity, writes the plist atomically at 0644, unloads any old job,
bootstraps it in `gui/<uid>` and starts it. It starts at login and restarts after
a crash, with a 10-second throttle. It allows 30 seconds for shutdown. No root or
linger is needed. The plist pins node, bundle and config paths and captures only PATH, with node's directory first.
Strings are XML-escaped; relative paths and control characters are refused.

The LaunchAgent runs `run --supervisor launchd`. Only this supervisor value is
accepted. Under this flag, permanent exits 64, 69, 77 and 78 log `service.stopped`
and write `{ code, at }` to
`${XDG_STATE_HOME:-~/.local/state}/phosphor-host/service-exit.json` at 0600, then
exit 0 so launchd leaves the job stopped. Other exits and signal behavior do not
change. Usage errors under this flag are also recorded as permanent stops, even
before config parsing. A new supervised run clears the old record only after
acquiring the run lock. `service status` shows only
state, pid and last exit code from launchd, the recorded permanent failure reason,
and the normal machine summary. It never prints launchd's environment dump.

`service logs` reads the last 200 Host log lines and the last 50 lines of
`launchd.err.log`, if present, from the Host log directory. Each read uses at most
256 KiB. `--follow` starts at the next unread byte and follows the Host log by
name across rotation; a missing file starts at byte 1. Standard output goes to `/dev/null`;
launchd captures stderr in that error log. Only the service's own process, after
acquiring the run lock and verifying that its fd 2 is the owned regular log file,
reduces an error log over 1 MiB to its last 256 KiB. Symlinks are never followed.
Restart uses `kickstart -k`; a missing job asks you to install it. Uninstall unloads the job and removes only the plist,
not config, identity or state. Missing jobs and files are already uninstalled.
This service is for a remote Host; it is never needed on a Mac you use Desktop on.

Service commands exit 69 on other platforms. No service command uses a shell;
child stdin is ignored. Test runners replace service managers and log followers.

## pi's environment

The Host filters its environment through one policy rather than inheriting it
wholesale. Only allowed variables present in the Host process reach pi. A terminal,
`env -i` and a service manager can supply different values or omit credentials;
config pins program paths and builds PATH independently of that ambient PATH.

| Class             | Names                                                                                                                                                               |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Base              | `HOME USER LOGNAME SHELL LANG LANGUAGE LC_* TZ TMPDIR XDG_CONFIG_HOME XDG_DATA_HOME XDG_STATE_HOME XDG_CACHE_HOME XDG_RUNTIME_DIR`                                  |
| Provider          | The names Desktop takes from a login shell (`pi/forwarded-env.ts`): the `AWS_`, `ANTHROPIC_`, `OPENAI_`, `PI_` and other provider prefixes, and the proxy variables |
| Operator          | `environment.pass`                                                                                                                                                  |
| Ambient authority | `SSH_AUTH_SOCK SSH_AGENT_PID GPG_AGENT_INFO DISPLAY WAYLAND_DISPLAY DBUS_SESSION_BUS_ADDRESS KRB5CCNAME`: only when passed, and doctor warns                        |
| Never             | `LD_* DYLD_* NODE_OPTIONS BASH_ENV ENV PROMPT_COMMAND SHELLOPTS BASHOPTS IFS PS4`, even when passed                                                                 |

`TERM` is left out, so a Host started from a terminal behaves like one started
by a service manager.

- **PATH** is `pi.node`'s folder, then `environment.path`, then the platform
  defaults: `/usr/local/bin /usr/bin /bin /usr/local/sbin /usr/sbin /sbin`, with
  `/opt/homebrew/bin` first on macOS. The Host's own PATH never reaches pi.
- **pi's directory layout** (`PI_CODING_AGENT_DIR`, `PI_CODING_AGENT_SESSION_DIR`,
  `XDG_*`) comes only from the Host's own environment, so the Host and pi agree
  on where sessions live.
- **Secret values** are those of a credential-like name (`KEY`, `TOKEN`,
  `SECRET`, `PASSWORD`, `PASSWD`, `CREDENTIAL`, `AUTH`, `COOKIE`, `PROXY`), a provider
  variable other than `PI_*`, or any passed name, when the value has 8 or more
  characters. `PI_*` values are pi's settings and paths. Every string in a
  doctor report has each secret value replaced with `[redacted]`, overlapping
  values included, and reports list variable names, never values. PATH is
  shown as its folders.

## doctor

doctor starts no session and calls no provider: every program it runs is asked
for a version or a status. Only a failure changes the exit code. When several
fail, a config problem (78) outranks a missing prerequisite (69).
A missing config ends with `next: run phosphor setup`, also in `--json`.
An invalid existing config does not get that next step.

| Check                          | Rule                                                                                                                                                                                                                                                                                                                | On failure    |
| ------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------- |
| `host-node`                    | The node running the Host is 22.19.0 or newer, as npm orders versions: a 22.19.0 prerelease is older.                                                                                                                                                                                                               | 69            |
| `config`                       | Found, owned as above, parsed and valid. doctor stops here when it is not.                                                                                                                                                                                                                                          | 78            |
| `environment`                  | Warns about ambient authority, and about passed names the Host's environment does not have.                                                                                                                                                                                                                         | warning       |
| `hello`                        | The HostHello holds no secret value of pi's environment. One that would is never shown or presented; the check names the field and the variable, never the value.                                                                                                                                                   | 78            |
| `pi-node`                      | An executable file whose `--version` satisfies pi's `engines.node` as npm checks engines, prereleases included: npm comparators (`>=`, `^`, `~` and the rest) joined by spaces and `\|\|`. A range with any other part, such as `22.x`, or one that is not a string, fails. 22.19.0 or newer when pi declares none. | 69            |
| `pi`                           | A Node script needs `pi.node` (78). `--version` is 1.2.0 or newer and matches pi's own package.json when it has one.                                                                                                                                                                                                | 69            |
| `git`                          | `git --version` succeeds for the first `git` on pi's PATH.                                                                                                                                                                                                                                                          | 69            |
| `extensions`                   | The six bundled extensions, and every helper they import from beside themselves, are under `<resourceRoot>/pi-ext/`.                                                                                                                                                                                                | 69            |
| `repository`                   | Each root resolves to an existing folder other than `/`. A root holding the home folder, or one level under `/`, warns; one that is not a git repository is noted.                                                                                                                                                  | 69            |
| `agent-dir`                    | pi's agent folder exists, meaning pi has run as this user.                                                                                                                                                                                                                                                          | warning       |
| `providers`                    | Once pi itself passes: a provider is signed in, and pi's default provider is, when it has one ([providers](#providers)).                                                                                                                                                                                            | warning       |
| `Tailscale`, `Tailscale serve` | Checks local Tailscale readiness and the configured Serve route. Missing transport warns; Funnel or a conflicting route fails.                                                                                                                                                                                      | warning or 78 |
| `context-budget`               | The effective session context budget.                                                                                                                                                                                                                                                                               | never         |
| `accounts`, `compression`      | Unavailable on a Host: pi uses the logins of the user running it, and there is no Headroom proxy.                                                                                                                                                                                                                   | never         |

Two lanes come out of the checks:

- **native** is available when no check failed.
- **claude** needs the native lane, `@saccolabs/pi-claude-cli` 0.10.0 or newer in
  pi's global packages (the gate Desktop uses, `claudeContextProviderShortfall`),
  and a `claude` on pi's PATH that `claude auth status` reports logged in. Only
  `loggedIn` is read from that output, and a failure is described from stderr
  alone: the email and organization beside it identify a person.

When nothing failed, the report ends with the next setup step (`next` in
`--json`, beside `providers`). While nothing is signed in and the Claude lane is
unavailable, it is `phosphor providers`. Otherwise it is an accept that passes as
written, since a lane runs on pi's default unless told otherwise and pi ignores
a provider named without a model:

| When                                                             | next                                               |
| ---------------------------------------------------------------- | -------------------------------------------------- |
| pi's default is `pi-claude-cli` and the Claude lane is available | `accept --repository DIR --lane claude`            |
| pi's default is another provider, signed in                      | `accept --repository DIR --lane native`            |
| another provider is signed in (the first in the list)            | `accept ... --lane native --provider P --model ID` |
| only the Claude lane is available                                | `accept ... --lane claude --claude-model ID`       |

`--json` adds a diagnostic `hello`: the configured local host id, Host version,
protocol 1, a fresh inspection UUID epoch and `sessions.read`/`sessions.control`.
`validateHostHello` checks it, and the `hello` check omits it if it would expose
an environment secret. It is not the enrolled daemon's signed hello: the running
[API](#api) uses the enrolled UUID, its process epoch and registered capabilities.

## providers

`phosphor providers` runs doctor's checks, then asks this Host's pi, in pi's
environment, about each provider it can sign into: the list Desktop's Accounts
tab shows (`SUBSCRIPTION_PROVIDERS` in
`libs/session-runtime/src/pi/provider-auth.ts`), plus pi's default provider from
its `settings.json` when that is another, such as an API key the config passes.
`pi-claude-cli` is left to the Claude lane.

Each check is `pi auth check --provider ID --json --no-refresh`: no network, and
never `--credentials`, so pi prints a status and no credential. Nothing says
which account is signed in, so no report holds an email. A row is `signed in`,
`not signed in`, or why the check failed: pi does not offer the provider, pi
could not read its models or credentials, or the check did not finish. pi's
default is marked.

It exits 0 when a provider is signed in or the Claude lane is available, and 69
when neither is, with `phosphor providers login` as `next`. When pi itself fails
doctor, nothing is asked: it prints doctor's report and exits with doctor's code.

### providers login

`phosphor providers login PROVIDER` signs in to one provider on this Host with
that provider's own login, then prints `phosphor providers` again. PROVIDER is an
id the list shows, pi's default included, or `claude` for the Claude lane. It
needs a terminal (stdin and stdout), and exits 64 without one; over SSH, use
`ssh -t`. The steps go to stderr first:

- **A pi provider** runs this Host's pi, in pi's environment plus the terminal's
  `TERM`, in a new empty folder that is deleted afterwards, with `--no-session
--no-approve --no-extensions`: no session file, no project trust question, no
  extension. There you type `/login PROVIDER` and press Enter (pi's completion can
  take the first Enter), choose to sign in with an account if pi asks, and follow
  it. A device-code
  provider shows a link and a code; a loopback provider shows a link, and when the
  browser on your computer ends on a `localhost` address that does not load, you
  paste that address into pi. Then `/quit`. pi has no login command outside its
  screen, which is why the steps are typed.
- **`claude`** runs `claude auth login` from pi's PATH: open the link, paste back
  the code the page shows.

The program shares the terminal and the Host's process group, so it can read
what you type; a signal to the Host (a closed SSH session) stops it, with SIGKILL
after 2 s or at a second signal. The credential is written by pi or claude, in
their own stores, and never passes through the Host. Afterwards the Host asks
again, as `providers` does, or with `claude auth status` for `claude`: it exits 0
when the provider is signed in and 69 when it is not, saying which on stderr.
Signing in to a provider that already is, `claude` included, replaces that login,
and the Host says so before starting. If it is still signed in afterwards, the Host
cannot tell the new login from the earlier one (it never reads a credential), so
it says that the earlier one is still there if the login did not finish. An
unknown provider exits 64 and starts nothing.

Desktop also starts this same login path from Machines Readiness. Its
`provider.login {provider}` command has a machine-scoped, owner-only receipt,
no lane or fence, and requires `terminal` plus `sessions.control`. Both are
checked at admission, when queued work starts, and after inspection before
spawn. The Host validates the id against its own provider list (or `claude`);
no client executable, argv, environment or path is accepted.

The login runs in a Host-owned PTY using the terminal topic, sequencing and
byte limits. Only its creating client identity can subscribe, type, resize or
kill it. Another client receives the same refusal as for an unknown terminal.
The same client can reconnect. There is at most one login per provider and two
per Host, also subject to the overall terminal limit. Exit, grant or capability
loss, and Host shutdown kill it; disconnect kills it after ten minutes without
reattachment. Closing the Desktop modal kills it while connected. Login input,
output and scrollback stay in memory only and are never logged or persisted.
An exit before the first subscription keeps a content-free completion tombstone
for at most ten minutes, removed once its owner receives the exit. Tombstones
exclude all output bytes, do not count toward the one-per-provider or two-login
limit, and do count toward the overall 32-terminal Host limit.
The credential stays in pi's or Claude's own store. Control receives none of it.

## accept

Claude acceptance validates its model selection before starting a session.

`phosphor accept --repository DIR` runs real sessions on this machine and
reports what they proved. DIR must be inside a configured repository. Use an
empty one that Desktop never opens: the lane store indexes transcripts but does
not lock them against another process. accept runs doctor first, and if the machine fails
it, prints doctor's report and exits with doctor's code.

`--lane native` runs on pi's default provider and model, or on the model
`--model` names, which `--provider` can narrow to one provider. pi ignores a
provider named without a model, so `--provider` alone exits 64. Name a native
model when pi's default is Claude. The lane must run on the provider named, or
on pi's default when none is, which must be some provider other than
`pi-claude-cli`. `claude` runs on `pi-claude-cli` and the model `--claude-model`
names. Without one, pi's default must be Claude; otherwise acceptance refuses
with usage exit 64 and a `--claude-model` hint before starting any session.
This preflight also applies to an available Claude lane in `--lane all`. Each lane
must run on the model named: pi's model id, which may carry a `:level` thinking suffix or be written
`provider/id`, with the provider named or, when none is, the one the lane runs
on.
`all`, the default, runs native and then Claude, if doctor finds the Claude lane
available; otherwise that lane is recorded as unavailable with doctor's reason.
Asked for alone, an unavailable Claude lane exits 69. Each lane's request is
checked before any session starts, and one that cannot run exits 64.

Each lane runs these steps and stops at the first that fails:

1. **start**: start a session through the request parser, wait for the
   `phosphor-context-breakdown` status, and find `phosphor-context-budget` in
   `get_commands`. Together they prove the bundled extensions loaded in pi.
2. **state**: `get_state` gives the provider, model, thinking level and session
   file. The provider and model must match the lane.
3. **prompt**: ask for a fresh `PHX-` token back. `get_last_assistant_text` must
   hold it.
4. **abort**: ask for a long count, abort at the first text delta, and expect
   `agent_end` within 10 s and pi no longer streaming.
5. **dispose**: stop the session. Its process group must be gone.
6. **resume**: start again from the session file. `get_messages` must hold the
   token reply and the aborted turn, and a recall prompt must return the token,
   so the provider received pi's context.
7. **close**: stop again, check that the transcript parses as JSONL, and delete
   it through the deletion service unless `--keep-transcripts` is set.

Only the token and the recall depend on the model. A start may take 60 s,
extension status included, a turn 180 s from its prompt, and a stop 20 s; the
abort's 10 s count from sending it, and pi must answer any other command within
30 s. A failed step exits 1 and keeps its transcript; the session it left
running is stopped, within 20 s too. A failed cleanup exits 70 instead: a
process group still there after a stop; a stop that does not end, as when a
process that left pi's group holds pi's output open after pi; or a transcript
the deletion could not remove, which is kept. accept then drains the runtime and
exits 70 if the drain failed.

stdout gets the evidence, as JSON with `--json`, with every secret value of pi's
environment hidden: the verdict; the machine; the Host, pi and Claude versions;
the names in pi's environment; for each lane its provider, model, thinking
level, each step with its time, whether the extensions loaded, any group left
and whether transcript deletion completed; the drain result; and the log path.
stderr gets the log path and one line per step, redacted the same way, so a
passed `XDG_STATE_HOME` or `HOME` is hidden in the path. An error accept did not
expect is printed as an internal error, redacted too.

## Running other programs

Every program a check runs goes through `machine/probe.ts`:

- stdin is `/dev/null`. A program that reads stdin to EOF, as `pi -p` does,
  waits forever on a pipe nobody closes (see the `pi -p` note in
  [CLAUDE.md](../CLAUDE.md)).
- The program leads its own process group. A timeout, 10 s or 15 s for pi,
  SIGKILLs the whole group, grandchildren included.
- Output past 64 KiB is read and dropped, so the program never blocks.
- The environment is exactly pi's, as built above.
- Output comes back with every secret value of that environment hidden, before
  a check picks a line or shortens it. Where the 64 KiB cap cuts through a
  secret, the piece it kept is hidden too.

SIGHUP, SIGINT and SIGTERM kill every running probe before the Host exits,
because a terminal's Ctrl-C does not reach another process group. While
sessions run, a signal drains them first ([Lifecycle](#lifecycle)).

## Sessions

`session/runtime.ts` composes the session runtime for this machine:
`createHostRuntime` takes what doctor validated and binds every port the
library asks for. `accept` and `run` share doctor's machine inspection. If `run`
cannot build a usable machine, heartbeat and authentication keep running without
a lane service. It logs only `lanes.unavailable` with a fixed reason token.

- **One service, one lock domain.** Starts, resumes and deletions go through
  the library's service and deletion, which share one registry and one
  path-lock domain, as on Desktop.
- **Dialogs are cancelled by default.** Each `select`, `confirm`, `input` or
  `editor` request is answered with pi's cancel, which the extension reads as
  no answer. The request still reaches delivery. With `dialogs: 'forward'`,
  the runtime leaves requests open for controller answers through
  `extensionUiResponse` and logs only the method. `accept` keeps the default;
  `run` opts into forwarding for its lane service.
- **pi as pinned.** pi starts from `pi.node` and `pi.executable`, never a stub,
  with exactly the environment built above plus `PI_CLAUDE_CLI_CONTEXT=pi`:
  nothing the Host inherited reaches it. It loads the six extensions from
  `<resourceRoot>/pi-ext/` and leads its own process group.
- **Fixed policy.** The default agent directives, with no per-project
  overrides; pi's own settings for the default provider, and pi's packages for
  the Claude gate; the config's context budget and every CLAUDE.md / AGENTS.md pi
  finds. There are no Desktop account overlays, Headroom or recents. `run` supplies
  routine ownership guards for manual commands, resume, stop and deletion. Only
  the idle context-budget fallback pauses for routine-owned sessions; native
  in-loop compaction remains enabled.
- **The same git.** Creating the runtime sets the Host's own PATH to pi's, so
  the git the Host asks about a repository is the git pi runs.

### Machine awareness

Host lanes, including routine runs, receive the shared
[machine-awareness directive](chat.md#agent-directives) after the worktree guard.
The label comes from a nonempty label in local non-secret enrollment metadata,
`identity/host.json`, otherwise the hostname. Prompt construction never loads the
signing key. The block identifies the label and OS, says the user
works from another computer over private Tailscale and cannot see the Host's screen,
and gives these instructions:

- `phosphor status` and `phosphor doctor` are safe to run here.
- Do not use SSH or other remote shells to start, drive or message Phosphor
  agents on other machines.
- Do not stop, restart, update, log out or reconfigure the Host service, or edit
  its config folder: the lane would cut itself off.

It also lists configured repository basenames, never their full paths. Labels,
OS names and repository names are reduced to printable ASCII without angle
brackets and with whitespace collapsed. Label/OS limits are 24/12 characters;
a label emptied by cleaning becomes “this machine”. Empty cleaned repository
names become “unnamed”. Each name is capped at 24 characters; at most 20 fit into a
96-character comma-separated list, followed by “and N more” for omitted names.
Repository add/remove updates the context for the next lane spawn or resumed
process, not an already-running pi. Callers still cannot supply
`appendSystemPrompt`; it remains a Host-owned request field.

### Lane runtime

`run` composes live lanes, commands and read-only calls over one runtime and one
store. It mints one epoch for the streams and API. The API adapter owns receipt
delivery and controller presence; composition supplies deferred ports for them.

`lanes/runtime-host.ts` buffers startup pushes until creation knows the lane id,
at most 256 pushes and 1 MiB per start. Overflow discards the whole buffer and
logs only the lane id. Attachment replays the buffer and waits for the first full
refresh, which resets viewers. Failed creation discards the buffer. Stopping a
lane stops its runtime session and detaches it. An unexpected exit keeps the
failed projection. Successful model, thinking and name changes refresh state.

Resume uses the stored cwd and session file, never a fresh transcript. A missing
or null recorded file fails to start. Stop and model changes learn pi's current
file and update the lane index.
An extension move followed by daemon shutdown or a crash before either can leave
the stored file stale ([HL1](known-issues.md#host-lanes)).

`lanes/calls.ts` dispatches registered machine features plus repository listing
and six lane queries: state, messages, stats, models, commands and the
[receipt summary](remote-protocol.md#lane-receipt-call). Params must
be an object; lane queries require a UUID lane id and
ignore other keys. Removed or unknown lanes fail. Stopped state is null; stopped
messages and receipt summaries use the same reader as snapshots, including an
empty transcript for a file not written yet. Other stopped queries fail
`lane-stopped`. Reader failures are
`internal` or `too-large`; live RPC failure, invalid shape or a 30-second deadline
is `internal` with fixed text. No pi error or stack leaves this query boundary.
Capabilities, concurrent-call bounds and frame sizing belong to the API adapter.

### Creating lanes

The lane command service creates lanes in an active configured repository or a new
worktree under `<repo>/.phosphor/worktrees/`. The creator controls the lane at
fence 1. Creation still returns `done` if its initial control publication fails;
it tries the summary and the next lane operation republishes control first.
An unexpected projection error after attachment returns `unknown`, not `failed`.
The API adapter dispatches `lane.create` to this service through the durable
command pipeline.

Worktrees use a valid git branch, never the default branch or one checked out
elsewhere. The branch with `/` replaced by `-` names the folder: 1 to 100 ASCII
letters, digits, dots, underscores or hyphens, starting with a letter or digit,
without `..`. Existing folders are refused. New branches start from the local
`origin/<default>` ref, then the default branch, then `HEAD`. No fetch runs.
On failure, the service stops any session it started and removes only the worktree
it created, without force. It removes a branch it created only if its commit has
not moved. Dirty worktrees are left in place. A failed attachment hides the stored
lane row.
For an existing branch, a clean worktree registered by another process at the same
path at the same instant can be removed, but never one with changes.
A process that can write the repository folder can still race git between the
containment check and the spawn; the Host trusts the owner's repository folders.

`lane.create` with `worktree.fresh: true` requests new-only branch creation. The
Host checks for an existing ref before repository writes, then atomically creates
the ref with `git update-ref` against an absent value. An existing or racing ref
returns `branch-exists`; it never reuses that branch. Older Hosts that ignore the
additive `fresh` field can reuse an existing branch when no lane or checked-out
worktree excludes it.
Desktop's bounded name retries are owned by
[remote creation](remote-desktop.md#machine-context-and-lane-creation).

A provider id is at most 64 characters; a model id is at most 128. A model alone
uses pi's provider selection. A provider alone does not change that selection.

### Lane snapshots

The lane projection holds settled pi messages, state, the turn in flight,
open extension dialogs and the latest status, widget and title values. It never
holds stderr. The Host binding refreshes it through the session runtime and the
API serves its snapshots over authenticated subscriptions. Its idempotent
`dispose()` stops refreshes and clears timers without sending to pi or changing the last projection view.
Pending events and UI keys are bounded.
Snapshots reserve 64 KiB for the wire envelope. Oversized snapshots replace
image data, oldest first, with `[image omitted: <n> KB]`; if they still do not
fit, the binding returns `too-large` rather than truncating text.
A viewer attaching after a tool call settles sees arguments as pi recorded them,
the same as reopening a session; original streamed text formatting is not kept.
After compaction, an attaching viewer sees the compacted transcript, the same as
reopening the session. A live viewer keeps earlier items until it reattaches.
During the post-compaction refresh, a snapshot keeps the earlier transcript,
the divider and subsequent events in live order.

The unattached snapshot reader reads a stopped lane's context from pi's session
file, with `state: null`. A null or missing file means an empty transcript: pi
creates the file when the first message is sent. The same snapshot size and image omission
rule applies. Reads are synchronous, capped at 64 MiB, and cached for four lanes;
invalid or inaccessible files refuse a stream subscription as `unknown-lane`,
while a `lane.messages` call maps reader failure to `internal` (or `too-large` for
size failures). The running Host serves this reader for stopped lanes.
The reader trusts the owner's pi sessions folder; a process that can write it
can race the containment check.

### Streams

`lanes/live.ts` binds each live projection to an epoch-scoped lane stream.
A pi push is applied and published in one synchronous step; stderr stays on
this machine. Sequence numbers start at 1, with snapshots at 0 before any event.
Replay is bounded by count and bytes. Reentrant publication stays ordered through
a bounded FIFO; a runaway listener causes a logged reset on the next macrotask,
not an unbounded drain. Publications before that reset are covered by it;
publications inside it follow normally. Viewers skip live frames already covered
by their snapshot or replay cursor. Detach publishes the stored summary again
when it differs from the live one.
The first projection refresh resets early viewers to the loaded transcript.
Unattached lanes use the stopped-transcript reader rather than a fabricated
empty view. Invalid live titles/models fall back to valid stored values or null;
invalid stored branches become null. Summaries and topic changes pass the wire
parser before publication.

The per-Host `lanes` topic shares one counter for lists, changes and attention.
Finished runs, new needs-input transitions and failures increment persisted
attention. [Protocol stream rules](remote-protocol.md#frames-and-streams) own
cursor replay, reset snapshots, bounded slow-consumer recovery and oversized
subscription/result behavior. `lanes/subscriptions.ts` implements that adapter;
a failed send closes the socket and its subscriptions. Failure logs carry code,
topic and trace, never the client-chosen subscription id. Closing the subscription
manager removes its listeners and recovery timer.

### Requests

A session starts or resumes only from a request, which `session/request.ts`
checks. Its keys are closed: `env`, `binaryPath`, `prefixArgs`, `extensions`,
`appendSystemPrompt`, `cwd`, `forkFrom` and `sessionId` are refused by name, as
is any other unknown key, and every problem comes back at its JSON pointer. No
message repeats a value from the request.

| Field           | Rule                                                                                                                                                                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repository`    | Required. An absolute path whose real path is a folder inside a configured repository. Traversal or symlink escapes and `/repo2` beside `/repo` fail; contained paths resolve to their real location. A missing folder gets the answer one outside gets. |
| `sessionPath`   | To resume. A regular `.jsonl` file, not a symlink, directly in pi's session folder for `repository`: otherwise `--session` would let pi append to any file. A file anywhere else gets one answer, existing or not.                                       |
| `provider`      | A letter or digit, then up to 63 letters, digits, `.`, `_` or `-`.                                                                                                                                                                                       |
| `model`         | A letter or digit, then up to 127 letters, digits or `._:/@+-`.                                                                                                                                                                                          |
| `thinkingLevel` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`.                                                                                                                                                                                             |
| `name`          | 1 to 120 characters, with no control, line-break or text-direction characters and no leading `-`.                                                                                                                                                        |

No value can start with `-`, so none can become one of pi's flags. A file that
one of this Host's sessions is running on is not started twice: a second start
is refused, even one racing the first, and a file a session may be moving to
counts too (see [Session commands](#session-commands)). A deletion names only
`repository` and `sessionPath`. It refuses a running session, cancels a start of
the same file still under way, and unlinks only one of pi's session files: a
regular `.jsonl`, not a link, directly in a folder of pi's session root. All of
this holds within one Host process: a pi that Desktop or another process runs on
the same file is not seen. The lane store does not provide cross-process ownership.

### Session commands

The in-process session runtime accepts pi RPC commands except the following.
Remote callers use the narrower [Host protocol allowlist](remote-protocol.md),
not arbitrary RPC. These runtime refusals preserve session-file ownership:

- `new_session`, `switch_session`, `fork` and `clone`. Each moves pi to another
  session file, and only a request starts or resumes one.
- `export_html` with an `outputPath`. An export goes where pi puts it.
- Any type that is not one of pi's.

A prompt that starts with `/` can run an extension command, and that can move pi
to another file. pi answers such a prompt only once the command has finished,
failed or not, and the Host then asks pi which file it writes. From the prompt
until that answer, it admits no resume and no deletion, of any file: each is
refused, to be tried again. A new session is never held up, since its file is
new. An extension that moves pi after its command ends is relearned by the session
service on its next slash-command prompt. Lane Stop and model changes separately
learn the current file for the durable lane index; see [HL1](known-issues.md#host-lanes).

If pi then cannot say which file it writes, because `get_state` fails, names no
file or gets no answer since pi has exited, the session counts as lost. Every
resume and deletion is then refused until that session is stopped, or until a
later answer names its file. pi 0.87.1's `get_state` fails, for one, once the
last `session_info` entry in its file has a name that is not a string. Only a
file that pi did not write can hold one. Such a session refuses prompts as well.
Stopping it always clears it, and so does a later answer that names its file
once the file is fixed, for instance by `set_session_name`, which appends a name
that is a string.

These rules keep the Host's own records and admissions consistent. They do not
confine extensions: an extension runs inside pi as the user, so it can move pi
to any file, even one another session writes, and the Host learns of the move
only afterwards. Nor are they an authorization boundary: `bash` runs as the user
anyway. The [Host protocol](remote-protocol.md) and its command allowlist
authorize remote controllers.

### Lifecycle

`booting → validating → ready → draining → stopped | failed`. Only `ready` takes
new work. From `draining` on, a running pi takes reads and interrupts only. A
drain:

1. Asks each pi whether a turn is in flight. If one is, it aborts the turn and
   waits up to 5 s for it to end: pi saves a turn when it ends, so the abort
   keeps it.
2. Stops each pi: SIGTERM to its process group, SIGKILL 3 s later.
3. Gives every process group this Host started 1 s to be gone: `kill(-pgid, 0)`
   fails with ESRCH. Past pi's own exit, a group is checked every 20 ms until
   its last member goes. The system hands the number out again only after
   that, so a reused number would have to come round within one check to be
   mistaken for it.

The drain has 15 s in all, this last check included. Once they pass, or once a
second drain request arrives, every group left is SIGKILLed at once, whatever
step the drain is at, and both requests get the same result. Any stop still
under way and the last check then share one more second, so a drain returns
within 16 s. It counts the sessions, the turns saved and the turns that did not
end in time, and it ends `failed` on a cleanup error, at the deadline, or with a
group left; otherwise `stopped`.

`run` starts API shutdown, closing sockets with 1001, and cancels naming work.
Heartbeat, runtime drain and routine-worker shutdown proceed concurrently.
After the runtime and routines stop, commands close, terminals and attachments
close, the routine database closes, live lanes close, the store closes and the
run lock releases. Command close refuses new
work, discards queued work and waits up to 2 seconds for any tail left after
runtime drain. Late callbacks skip publication and store writes. A second signal
forces runtime drain immediately. Start-up signals still abort reconciliation
and release the run lock without publishing a heartbeat.

accept drains when it finishes. A signal drains the sessions of a running accept
first, then exits 128 + its number, or 70 if the drain failed; a second signal
forces the drain. An uncaught exception or unhandled rejection is logged,
printed redacted and drained, with every group killed if the drain still runs 2
s later, and the Host exits 70. One during a signal's drain forces that drain,
and the Host exits 70, not the signal's code. Every exit first lets stdout and
stderr flush, for 1 s at most. The code is read when the flush ends, so a fatal
error during it still exits 70, after flushing its message too. The Host exits
when its command ends, unless a signal's drain is still running: a pipe of pi's
held open by a process that left its group would otherwise keep it running.

### Log

The Host API logs `api.hello` with a validated `x-phosphor-trace` header when
present. WebSocket `auth.trace` is optional and strictly validated as 16 lowercase
hex characters. Its initial value follows the connection through `api.connected`,
command admission (`api.command` with operation), receipt delivery (`api.receipt`
with status), and `api.closed` with code and duration. These API events omit ids,
paths, grants and content; field values match `^[A-Za-z0-9._-]{1,64}$`. Missing
traces are omitted, and renewal does not change the connection trace.

`${XDG_STATE_HOME:-~/.local/state}/phosphor-host/logs/phosphor.log`, rotating at
5 MB like Desktop's. Every line starts with ISO 8601 UTC and milliseconds.
`login`, `status`, `logout` and `run` log start and end with the exit code and
one command trace. Every signed control call sends that trace and the Host
version, then logs the route, status, duration, returned request id and safe
error code. Login records creation, polls, approval and the saved identity path
before its self check. Run records each sequence, state changes, retries with
delay and removal (exit 77). Service commands log unit writes/removal and program
arguments/results, never the captured environment or child output. Terminal
output stays the same. See [Tracing a machine](remote-development.md#tracing-a-machine).
The folder is 0700 and every file 0600, an older folder,
log or rotated log included. It records the runtime's inputs (pi's command, the
names in pi's environment, PATH, the repositories), each spawn's argv, pi's
stderr, unexpected exits, state changes and drain results. Spawn argv keeps the
`--append-system-prompt` flag but logs its value as `[redacted]`. Every string is
redacted before it is written, and so is every line of a secret that spans
lines, however short, since pi's stderr arrives one line at a time. A line that
is all whitespace is the one left alone: it holds none of the secret, and hiding
it would hide the spaces in every line. Any other line is hidden wherever it
appears, so a secret with a line like `}` hides every `}` in pi's stderr. A
secret gets through neither raw nor as its JSON escape. pi's stderr reaches a
session's delivery redacted the same way.

## Nx and CI

The Nx project `host` has `typecheck` (`tsc --noEmit -p apps/host/tsconfig.json`),
`test` (`vitest run apps/host`) and `build` (`node apps/host/scripts/build.mjs`,
output `apps/host/dist`), all uncached. It depends on the runtime,
shared and pi-extensions libraries, and only `tooling` depends on it, so a
Host-only change selects `host` and `tooling` and never releases Desktop. Root
`npm run typecheck:host` and `npm run build:host` run in the validator and in
CI's checks job; the unit tests, the bundle's included, run with every other
suite in `npm test`.

## Machine features

`run` registers the read features and file mutations only when the machine is usable.
`workspaces.read` covers `files.list` (tracked and non-ignored untracked paths),
`files.read` (text or binary size), `git.status` (per-path status, branch, ahead
and behind), `git.diff` (working or staged unified diff), and `git.show` (a file
at `HEAD` or a hex commit, including a session baseline).

File reads accept exactly one of `laneId` or `repositoryId`. A repository id must
match the current configured snapshot; paths are relative to that repository.
Git queries remain lane-only. Lane queries require a stored, non-removed lane
inside an active repository. Paths are relative to its cwd; traversal, symlink escapes and `.git` reads are refused.
Git-backed lists stop with `too-large` above 20,000 files. Non-git browsing
also bounds directory traversal and skips `.git`. Text and diffs are capped at
2 MiB. File reads classify binary by a NUL in the first 2 MiB; larger files
without a NUL in that sample return `too-large`. Git blobs over 2 MiB return
`too-large` before reading content, including binary blobs. Smaller binary
blobs return their size without content. Errors contain no paths or tool output.
Git runs with inherited `GIT_*` variables dropped, no pager, fsmonitor, external
diff or textconv, and no lazy fetch of missing objects. Clean filters that the
machine owner configured (Git LFS, for example) still run during `git.status` and
`git.diff`, as they do for the owner's own git. Turning them off can falsely report
filtered files, including Git LFS files, as modified. A caller cannot choose or
change the command.

The `skills.read` feature answers `machine.models` with the Host pi's model
catalogue and `machine.providers` with provider names and readiness only. It
never returns credentials or provider diagnostic text. Probes use the Host's
validated pi binary and configured environment, not call parameters.

`skills.list {laneId?}` resolves global skills and, when a lane is named, that
lane's project skills through pi. `skills.read {name, laneId?, file?}` resolves
again without remembering earlier calls. A project skill wins over a global
skill of the same name. Without a lane, only global skills are available.
`file` is relative to the skill bundle; it defaults to the resolved skill's
markdown file. Reads reject escapes and `.git`, cap text at 2 MiB, and label
binary files without returning content. Lists cap at 500 skills and 1,000 models.

The registered `artifacts.read` feature indexes an admitted lane's session file on
request under `hostStateDirectory()/artifacts`. `artifacts.list {laneId?}` returns
current-branch metadata for one lane or all admitted lanes, capped at 2,000 artifacts
and 1,000 versions per artifact, with 4 MiB of metadata per list.
`artifacts.read {laneId, slug, version?}` returns
one version, defaulting to the latest, capped at 2 MiB of UTF-8 content. Session
scans cap at 32 MiB. Calls run in FIFO order with at most eight waiting calls;
additional calls answer `internal` because call errors have no `busy` code.
The portable indexer and library live in `libs/session-runtime/src/artifacts/`.
No client names a session file, blob hash or storage path. Removed lanes are
excluded, including lanes removed during a read, even when derived blobs remain.
The API checks `artifacts.read` before execution and before delivery.

### File mutations

`workspaces.write` and `sessions.control` are both required at command admission
and again when a queued write starts. A closed connection has no permissions.
`files.write`, `files.create`, `files.rename`, `files.delete` and `files.transfer`
are lane-scoped, controller-only and fenced. Receipts are owner-only, not
capability-gated; receipts carry no content. They retain the existing durable
pending/done/rejected/unknown and deduplication rules.

Text reads include the SHA-256 revision of the exact bytes read, or null for a
missing file. Writes accept at most 2 MiB and require that revision (`expected`);
null means create only. A mismatch returns `conflict`. Writes stage an exclusive
temporary file in the same directory, fsync, rehash the target and replace it.
A new target uses link/unlink so a racing create is never overwritten. Temporary
files are removed on failure. Create uses exclusive open or non-recursive mkdir.
Regular-file rename uses link/unlink without replacement. Directory rename checks
that the destination is absent. Transfers share Desktop's naming and no-merge
rules, stay inside the lane and bound traversal to 40,000 guard checks. Directory
copies reserve the destination with exclusive mkdir before copying children.

Mutations lstat every component from the resolved lane root, refuse symlinks and
`.git`, and recheck parent realpaths before I/O. Node has no portable openat or
rename-no-replace for directories: an owner process can swap an ancestor after a
check, replace a directory destination before rename, or change existing bytes
between the last hash and replacement. These are same-user residual windows,
not isolation from the machine owner. Delete moves to `~/.Trash` on macOS or
`$XDG_DATA_HOME/Trash` (default `~/.local/share/Trash`) elsewhere, with exclusive
`.trashinfo` metadata on Linux. DeletionDate uses local time. Trash components are
validated as non-symlink directories, created one level at a time with mode 0700,
and destination parent realpaths are rechecked before metadata creation and the move.
Cross-device moves are refused, never copy-deleted.

### Attachments

`attachments.begin {name, size, mime}`, `attachments.chunk {uploadId, index, data}`
and `attachments.commit {uploadId, sha256}` use lane-scoped receipts. All three
require `workspaces.write` and `sessions.control`, the current fence and control
of the lane. Upload ids bind to the creating client, lane and fence. A control
change deletes open uploads. Chunks are strictly ordered, at most 256 KiB decoded;
a duplicate or gap aborts the upload. Commit verifies declared size and SHA-256
against both received and stored bytes. No unknown outcome is retried by Desktop.

Files are at most 20 MiB. Desktop allows ten attachments per prompt. The Host
bounds concurrency to ten open uploads per lane, rather than counting files per
message. It charges begun bytes, with a minimum 64 KiB per begin, against a 64 MiB
rolling hour per lane. A private, atomically replaced ledger retains 61 minute
buckets, conservatively keeping charges for up to one extra minute. Invalid or
unreadable ledgers charge the full hour; a backwards clock never frees quota.

The Host stores committed files under its state directory at
`attachments/<laneId>/`, never inside the repository. Directories are 0700;
exclusive files and quota ledgers are 0600. Names are sanitized. Partial files
live in the sibling `attachments-tmp/<laneId>/` directory, expire after one hour
and are swept on startup and every minute. Startup also deletes storage for
unknown or removed lanes. Finalized lane removal deletes files, partial uploads
and the ledger. Sweeps do not follow symlinks. Final names are reserved exclusively
before atomic rename; as with file writes, Node cannot eliminate same-user
ancestor-swap races without portable openat support.

Commit returns a small Host-local path. This is the documented path exception:
Desktop uses it in the prompt's `<attached-files>` block, exactly like local
non-image attachments, so pi on the Host can read the file. The path is visible
only where local attachment paths are visible, including the sent message.
Bytes, paths and upload ids are not logged. Inline images keep the normal pi
`images[]` flow; Desktop main refuses encoded image prompt frames above the
inbound frame limit minus a 1 KiB margin before sending, preserving the image draft.

### Host terminals

A Host with `lib/native/node-pty/` announces `terminal` only after its fixed-relative
loader succeeds. No global module lookup is used. Build the native resources on
the matching runner with `node tools/host-release/build-native.mjs --out DIR --node NODE`.
`NODE` must be the pinned Node 24.14.1 for that runner. node-pty is pinned to 1.1.0.
The builder discards Desktop's rebuilt addon, uses the shipped macOS prebuild or
rebuilds for the pinned Node, and proves spawn, resize, output and exit with that Node.
Pass the resulting directory to `build-bundle.mjs --native DIR`. Its target marker
must match `--target`. Native resources and the license are included in BUILD-INFO
and signed archive hashes. The macOS spawn helper has mode 0755 in the archive.
Linux uses node-pty's fork path and does not need the macOS helper.

`terminal.list {laneId}` returns identities and status, never paths. Receipt-backed
`terminal.create`, `terminal.resize` and `terminal.kill` require `terminal`,
`sessions.control`, and the current lane fence. Queued terminal operations recheck
both capabilities when execution starts and after directory admission, before PTY
mutation. Capability loss or a closed connection rejects queued work as `forbidden`.
Create accepts dimensions only.
The Host resolves the account's login shell and supplies its built lane environment
plus `TERM=xterm-256color` and the admitted lane directory. Limits are 8 retained
terminals per lane and 32 per Host, including exited/interrupted entries until explicitly killed.

Client disconnects leave PTYs running. Lane removal kills them within one second,
even without a connected client. Host shutdown kills them; after restart, retained
identities are `interrupted`. Only identities and status persist in private Host
state. Input and scrollback never reach disk. A routine never types into a terminal.

Viewers with `terminal` may subscribe to topic `terminal`. Output has an epoch and
monotonic sequence, chunks of at most 16 KiB UTF-8, and replay bounded by 256 KiB
and 2048 chunks. Missing, old, future or foreign-epoch cursors return
`terminal.reset` with bounded scrollback, status, and the last consumed `inputSeq`.
Only the current controller with both capabilities may send `terminal.input`.
Input is at most 4096 UTF-8 bytes per frame and 64 KiB per second per terminal.
Sequences must be exactly the last consumed sequence plus one. A write consumes its
sequence before entering the PTY, even if delivery becomes uncertain. Acknowledgements
report acceptance, not shell execution. Clients never retry uncertain input; a fresh
reset supplies the consumed sequence. Grant renewal removes terminal subscriptions
immediately when capability is lost. Slow consumers are disconnected rather than
buffering unbounded output.

Receipts and receipt-status replies are owner-only, not capability-gated.
Terminal receipts carry no content, only an opaque terminal id.
Every action that uses it checks the connection's current `terminal` capability;
holding an id grants no authority.

## Daemon routines

With a usable session runtime, the daemon registers `routines` and runs the
portable routines scheduler over `<state>/routines/state.sqlite`. Its directory
is owned and mode 0700; SQLite and sidecars must be owned regular files with mode
0600, never symlinks. No client must remain connected for an enabled schedule.
The Host bundle uses only builtin SQLite, with bundled pure-JavaScript calendar
helpers. Desktop's local routines use the same engine with their existing
Electron shutdown approval, runner and notifications.

`routines.list {}` and `routines.history {routineId, offset?}` require `routines`.
They return bounded definitions and history metadata without Host paths.
Machine commands are `routine.save`, `routine.run`, `routine.cancel`,
`routine.skipNext`, `routine.archive`, `routine.delete` and `routine.pauseAll`.
They have no lane id or fence and use the same durable request receipts as lanes.

| Command                                                      | Required capabilities              |
| ------------------------------------------------------------ | ---------------------------------- |
| Save paused/untrusted, cancel, skip next, archive, pause all | `routines`                         |
| Save trusted/enabled, run, delete                            | `routines` plus `sessions.control` |

Creation always starts paused and untrusted. A later save with `sessions.control`
explicitly acknowledges unattended full tool access, stored durably in Host SQLite.
This is a machine-scoped operation, not a lane-controller lease.
Authorization is checked against current capabilities before admission and again
before queued execution. Closed connections have no capabilities for queued work.
Receipts remain scoped to the requesting client and are not capability-gated.
Changes publish a small `routines-changed` invalidation on the lanes topic. Routine ids, definitions and
output are not logged.

The runner starts only in configured repositories, resolves `repositoryId`
locally and uses the session runtime's shared admission and path-lock domain.
It keeps the two-worker/source-folder limits, exact model check, catch-up/DST
policy, no automatic retries, failed-isolation refusal and blocked dialogs.
Routine ownership guards manual commands, resumes and deletion; the idle
context-budget fallback pauses while a routine owns its session. Shutdown stops
scheduling and workers before closing the routines database. A routine never
uses a terminal; a live shell is not an occupancy lock. See [routines.md](routines.md#host-routines)
for bounds, deletion policy and the connection capability matrix.

## Remote lane names and lifecycle

The Host owns the generated title; it does not rename the branch.

An unnamed lane immediately uses its first accepted user message as its summary
title: the first nonempty line, trimmed, at most 80 characters. The Host also
names new lanes after the first accepted prompt. `autoNameLanes` is a boolean,
default on. Naming failures stay out of chat. The Host logs `lane.naming` with
`laneId`, a fixed outcome token and elapsed `ms`, never prompts, titles or output.
Only one naming subprocess runs at a time, with at most 64 pending jobs. It uses
the lane's provider and the cheapest eligible model in the same family and region,
falling back to the lane model. Print mode has no stdin, tools, context files,
skills or templates; thinking is off. Fast boot loads only the Claude provider's
extension files when needed, resolved from the installed package with
`resolvePackagePaths`. Empty resolution skips naming with
`skipped-no-provider-package`. Print mode waits for stdout to close before
accepting its result. Every run has a 30 second timeout, a 4 KiB output cap,
and its own process group, killed on completion or failure. Host shutdown cancels
the active naming group and discards queued naming work.

A generated name is applied through the live lane's runtime, never by writing
pi's file. A manual rename, closed lane or changed incarnation cancels application.
There is one naming attempt per new lane. A controller's `set_session_name`
updates the stored summary and publishes the refreshed live name to viewers.
Stop before the first saved prompt is refused with a fixed message. Once pi
reports its session file, the Host records that identity before stopping. A
cross-provider model switch rebinds pi from its saved transcript, or recreates
an empty lane with the selected model when no file exists yet. Persisted names
are not parsed as creation names on resume; an unsaved name is restored via RPC. In-turn model
switches are refused.

## Repository management and lane deletion

`allowRepositoryChanges` is a boolean, default on. Turning it off refuses
`machine.folders.list`, `host.repositories.add` and `host.repositories.remove`.
These owner-authenticated operations require `workspaces.write`; mutations also
require `sessions.control` and use durable receipts. Folder paths are relative
to the Host user's real home. Absolute paths, dot directories and symlink escapes
are refused. Folder listing returns directories only, at most 500, sorted within
the returned subset, with `truncated` when more exist. Enumeration also stops
after 20,000 directory entries, including hidden entries.

Add accepts existing git or non-git directories, refuses duplicates and more than
64 configured folders. It reads the validated config, preserves other fields,
writes a 0600 exclusive temporary file, syncs it, then atomically renames it over
the canonical config. The added directory's canonical path, device and inode
are revalidated under home immediately before commit and publication, without an
asynchronous gap. Roots configured by hand may remain outside home; this check
applies only to newly added folders. Only then do the repository snapshot and runtime admission
roots change. This is process-local serialization, not a cross-process config
lock. Remove changes config only and refuses live repositories. The final folder
cannot be removed (`last-repository`). No repository files are deleted.

`lane.delete` requires the current controller, matching fence, `sessions.control`
and `workspaces.write`, checked again while work waits and before destructive
steps. It stops pi and its process group, then moves the transcript through the
runtime's shared path-lock domain into `<state>/trash/`. A startup sweep removes
matching trash files older than 30 days. Missing transcripts are allowed. A
shared worktree is never removed. Worktree removal uses git without force, so
dirty worktrees remain. A branch is kept unless its work is proven merged,
including squash merges by `git cherry` against a synthetic branch-tree commit.
Symbolic branch refs are kept. Every merged branch, by ancestry or squash, is
deleted the same way: worktrees are rechecked immediately before
`git update-ref --no-deref -d`, which compares with the proven tip atomically
so an advanced tip is kept. It checks worktrees
again immediately afterwards: a racing checkout causes a create-only restore of
the proven tip and reports the branch kept. Current and checked-out branches are
kept; these checks and restoration are not a cross-process worktree lock.
Kept branches are not deletion failures. The receipt returns only
`{branchKept: boolean}`; Desktop rejects missing or malformed confirmation as an
unknown outcome. Removal is published to every connected client. Resources already removed before a later
failure are not recreated; a retry can finish the remaining work.
