# The Host

The Host is Phosphor's plain-Node application for machines Desktop does not run
on. Its command is `phosphor`; its config and logs live in `phosphor-host`
folders, apart from Desktop's own. `setup` writes its config. `doctor` checks
whether a machine can run sessions, `providers` which models pi can use there,
and `accept` runs real sessions to prove it ([accept](#accept)). `login`,
`status` and `logout` manage its machine identity in the control plane. `run`
sends heartbeats; on Linux, `service` runs it as a systemd user service. It listens on
nothing. `npm run build:host` builds it
([Build](#build)); nothing installs or publishes it yet. Desktop never runs a
Host, and offline Desktop never needs one
([remote-access.md](remote-access.md)).

The source is `apps/host/src/`. It imports Node builtins and the exported
subpaths of `@phosphor/session-runtime` and `@phosphor/shared`, nothing else:
ESLint refuses Electron, `@shared/*` and `@/*`, and `boundary.test.ts` checks
every library import against the package's exports.

## Setting up a Host

Install the Host manually by copying a build to the machine ([Build](#build)).
The installer comes with signed builds, component 23.
Then run `setup`, `doctor`, `providers`, `accept`, `login` and `service install`.

1. `phosphor setup --repository ~/src/project` detects programs and writes an
   owner-only config. Without `--repository`, it uses the current git top level.
2. `phosphor doctor` checks the machine: node, the config, pi, git, the
   extensions and the repositories. Fix what fails and run it again.
3. `phosphor providers` lists what pi can sign into and whether each is signed in
   on this machine, with the Claude lane beside them. Until one is, its `next:`
   line says to sign in with `phosphor providers login PROVIDER`, in a terminal on
   the Host (`ssh -t` is fine): a pi provider id from the list, or `claude` for
   the Claude lane. It prints the steps, runs the provider's own login, and shows
   the list again. Open the link the login prints on any computer. The login is
   made on the Host and stays there: Phosphor never copies one between machines.
4. `phosphor accept --repository DIR` runs real sessions there. Use the exact
   command the `next:` line names, with DIR an empty repository from the config:
   it picks the lane and, when that lane cannot run on pi's default, the provider
   and model (`ID`, which `pi --list-models` lists).
5. `phosphor login` enrolls the machine. Approve its code and fingerprint in
   Desktop's Machines page.
6. On Linux, `phosphor service install` keeps it online after logout and reboot.

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
`contextBudget`, `environment.pass`, `accounts`, `control` and `resourceRoot`
when the old config loads and validates. A broken old file is replaced with a
note. A symlink is replaced, never written through.

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
phosphor run [--config FILE]
phosphor service install|status|restart|logs|uninstall [--config FILE]
phosphor service logs [--config FILE] [--follow]
phosphor version [--json]
```

stdout carries only the report or the JSON. Usage errors and accept's progress
go to stderr.
`version` prints `0.0.0-dev.<sha7>`, or `0.0.0-dev.source` when the build did
not stamp a commit.

| Exit          | Meaning                                                                                          |
| ------------- | ------------------------------------------------------------------------------------------------ |
| 0             | success                                                                                          |
| 1             | an acceptance check failed; its transcript is kept                                               |
| 64            | usage error                                                                                      |
| 69            | a prerequisite is unavailable; for `providers`, nothing is signed in; for `status`, not enrolled |
| 70            | internal error, a failed cleanup or the drain deadline                                           |
| 75            | control plane unreachable, invalid response, enrollment code expired or concurrent setup         |
| 77            | this machine was removed from the account                                                        |
| 78            | the config is invalid                                                                            |
| 129, 130, 143 | ended by SIGHUP, SIGINT or SIGTERM, after stopping probes and sessions                           |

## Build

`npm run build:host` writes `apps/host/dist/`, which git ignores. It runs
`node apps/host/scripts/build.mjs`, which also takes `--out DIR` and `--sha SHA`:

- `phosphor.mjs` and its linked source map: one ESM file for Node 22, built by
  esbuild from `src/main.ts`. Run it as `node phosphor.mjs <command>`.
- `pi-ext/`: the bundled extensions, copied with Desktop's filter (every `.ts`
  file but tests). A session loads them from beside the bundle unless the config
  sets `resourceRoot`.
- `skills/visual-artifacts/`: the same authoring skill and references Desktop
  ships. Before starting sessions, `accept` seeds a user-owned copy in pi's
  skills directory. Edits and deletion survive later runs; `doctor` never installs
  it. See [the shared lifecycle](extensions.md#the-artifact-tools-and-what-each-one-costs).
- `BUILD-INFO.json`: the version, the source commit, whether the tree had
  uncommitted changes, the Node target, and every file with its size and sha256.

The version is `0.0.0-dev.<sha7>` of the source commit, HEAD unless `--sha`
names another. The build fails if the bundle reaches Electron, `electron-store`,
`electron-updater`, `node-pty`, Desktop or the site, imports anything but a Node
builtin, or lacks one of the seven extensions. It only replaces an empty folder or
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
`.phosphor-build-*` folder. Nothing is signed; real versions and signed bundles
are component 23's.

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

## Config

The file is `--config FILE`, else `${XDG_CONFIG_HOME:-~/.config}/phosphor-host/config.json`
on Linux and macOS alike. No environment variable names it.

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

| Field              | Meaning                                                                                                                                                                             |
| ------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `hostId`           | Optional. Defaults to the short hostname, made to fit the HostHello identifier pattern.                                                                                             |
| `pi.executable`    | What `command -v pi` prints.                                                                                                                                                        |
| `pi.node`          | The node that runs pi. Required when `pi.executable` resolves to a Node script, as pi 0.87.1 does.                                                                                  |
| `resourceRoot`     | Holds `pi-ext/` and `skills/`. Defaults to the running bundle's own folder.                                                                                                         |
| `repositories`     | 1 to 64 folders that sessions may run in. Never `/`.                                                                                                                                |
| `contextBudget`    | Desktop's grammar; `""` or absent is the 200k default. A value Desktop would quietly replace with the default, such as `77k`, is an error.                                          |
| `environment.pass` | Up to 64 more variable names for pi. Names only, never values. Naming `PATH` or a hook below is an error.                                                                           |
| `environment.path` | Up to 32 more PATH folders.                                                                                                                                                         |
| `control.url`      | Optional bare origin. Defaults to `https://phosphor.saccolabs.com`. HTTPS, or HTTP only on localhost, 127.0.0.1 or ::1. No credentials, path, query or fragment. Ports are 1-65535. |
| `accounts`         | `null` or absent: accounts are unavailable on a Host.                                                                                                                               |

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
  removes it: a gate over 30 seconds old was left by a crash, and the message
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
readiness and the Host version, with zero lane counts and a null endpoint; the
Host has no listener. Requests carry a timestamp, random nonce and Ed25519
signature. No repository names, paths, transcripts or provider tokens
leave the machine. Redirects are refused. Requests time out after 10 seconds;
responses are capped at 64 KiB and validated with the shared wire contract.

## Running as a service

After `phosphor login`, `phosphor run` reports the machine's readiness to the
control plane every 30 seconds, or the interval the server returns, plus up to
3 seconds of jitter. pi, Claude sign-in and Tailscale are checked at start and
every five minutes. Each probe has a 2 second deadline and a 64 KiB output cap.
No session starts. Logs name state changes only, with no keys or signatures.

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
whether or not that beat succeeds. A second signal exits immediately with its
signal code, 130 for SIGINT.

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

Install reloads systemd, enables and starts the unit, restarts it to apply a
replacement, then enables linger for the current user so it survives logout
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

Service commands exit 69 on other platforms. No service command uses a shell;
child stdin is ignored. Test runners replace systemctl, loginctl and journalctl.

## pi's environment

The Host builds pi's environment rather than passing its own, so a terminal,
`env -i` and a service manager all give pi the same variables.

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

| Check                     | Rule                                                                                                                                                                                                                                                                                                                | On failure |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `host-node`               | The node running the Host is 22.19.0 or newer, as npm orders versions: a 22.19.0 prerelease is older.                                                                                                                                                                                                               | 69         |
| `config`                  | Found, owned as above, parsed and valid. doctor stops here when it is not.                                                                                                                                                                                                                                          | 78         |
| `environment`             | Warns about ambient authority, and about passed names the Host's environment does not have.                                                                                                                                                                                                                         | warning    |
| `hello`                   | The HostHello holds no secret value of pi's environment. One that would is never shown or presented; the check names the field and the variable, never the value.                                                                                                                                                   | 78         |
| `pi-node`                 | An executable file whose `--version` satisfies pi's `engines.node` as npm checks engines, prereleases included: npm comparators (`>=`, `^`, `~` and the rest) joined by spaces and `\|\|`. A range with any other part, such as `22.x`, or one that is not a string, fails. 22.19.0 or newer when pi declares none. | 69         |
| `pi`                      | A Node script needs `pi.node` (78). `--version` is 0.87.1 or newer and matches pi's own package.json when it has one.                                                                                                                                                                                               | 69         |
| `git`                     | `git --version` succeeds for the first `git` on pi's PATH.                                                                                                                                                                                                                                                          | 69         |
| `extensions`              | The seven bundled extensions, and every helper they import from beside themselves, are under `<resourceRoot>/pi-ext/`.                                                                                                                                                                                              | 69         |
| `repository`              | Each root resolves to an existing folder other than `/`. A root holding the home folder, or one level under `/`, warns; one that is not a git repository is noted.                                                                                                                                                  | 69         |
| `agent-dir`               | pi's agent folder exists, meaning pi has run as this user.                                                                                                                                                                                                                                                          | warning    |
| `providers`               | Once pi itself passes: a provider is signed in, and pi's default provider is, when it has one ([providers](#providers)).                                                                                                                                                                                            | warning    |
| `context-budget`          | The budget sessions will be held to.                                                                                                                                                                                                                                                                                | never      |
| `accounts`, `compression` | Unavailable on a Host: pi uses the logins of the user running it, and there is no Headroom proxy.                                                                                                                                                                                                                   | never      |

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

`--json` adds `hello`, the HostHello this Host would present: its host id and
version, protocol 1, a `runtimeEpoch` that is new on every run, and the
capabilities `sessions.read` and `sessions.control`. It is checked with
`validateHostHello` before it is printed, and left out when it would show a
secret value (the `hello` check).

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

## accept

`phosphor accept --repository DIR` runs real sessions on this machine and
reports what they proved. DIR must be inside a configured repository. Use an
empty one that Desktop never opens: nothing guards a transcript against a second
runtime until component 06. accept runs doctor first, and if the machine fails
it, prints doctor's report and exits with doctor's code.

`--lane native` runs on pi's default provider and model, or on the model
`--model` names, which `--provider` can narrow to one provider. pi ignores a
provider named without a model, so `--provider` alone exits 64. Name a native
model when pi's default is Claude. The lane must run on the provider named, or
on pi's default when none is, which must be some provider other than
`pi-claude-cli`. `claude` runs on `pi-claude-cli` and the model `--claude-model`
names; without one it runs on pi's default, which must then be Claude, and the
state step fails with a hint if it is not. Each lane must run on the model
named: pi's model id, which may carry a `:level` thinking suffix or be written
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
and whether the transcript was deleted; the drain result; and the log path.
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
library asks for. `accept` is its only caller.

- **One service, one lock domain.** Starts, resumes and deletions go through
  the library's service and deletion, which share one registry and one
  path-lock domain, as on Desktop.
- **Dialogs are cancelled.** Nothing can reach the Host to answer one until
  component 07, so each `select`, `confirm`, `input` or `editor` request from
  an extension is answered at once with pi's own cancel, which the extension
  reads as no answer: undefined, or false for a confirm. The log records
  `dialog cancelled`, and the request still reaches the session's delivery. A
  flow that needs a person, such as the MCP adapter's callback paste, fails on
  a Host for now.
- **pi as pinned.** pi starts from `pi.node` and `pi.executable`, never a stub,
  with exactly the environment built above plus `PI_CLAUDE_CLI_CONTEXT=pi`:
  nothing the Host inherited reaches it. It loads the seven extensions from
  `<resourceRoot>/pi-ext/` and leads its own process group.
- **Fixed policy.** The default agent directives, with no per-project
  overrides; pi's own settings for the default provider, and pi's packages for
  the Claude gate; the config's context budget, never paused; every
  CLAUDE.md / AGENTS.md pi finds. There are no accounts, no Headroom, no
  routines and no recents.
- **The same git.** Creating the runtime sets the Host's own PATH to pi's, so
  the git the Host asks about a repository is the git pi runs.

### Requests

A session starts or resumes only from a request, which `session/request.ts`
checks. Its keys are closed: `env`, `binaryPath`, `prefixArgs`, `extensions`,
`appendSystemPrompt`, `cwd`, `forkFrom` and `sessionId` are refused by name, as
is any other unknown key, and every problem comes back at its JSON pointer. No
message repeats a value from the request.

| Field           | Rule                                                                                                                                                                                                               |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `repository`    | Required. An absolute path whose real path is a folder inside a configured repository, so `..`, a symlink that escapes and `/repo2` beside `/repo` all fail. A missing folder gets the answer one outside gets.    |
| `sessionPath`   | To resume. A regular `.jsonl` file, not a symlink, directly in pi's session folder for `repository`: otherwise `--session` would let pi append to any file. A file anywhere else gets one answer, existing or not. |
| `provider`      | A letter or digit, then up to 63 letters, digits, `.`, `_` or `-`.                                                                                                                                                 |
| `model`         | A letter or digit, then up to 127 letters, digits or `._:/@+-`.                                                                                                                                                    |
| `thinkingLevel` | `off`, `minimal`, `low`, `medium`, `high`, `xhigh` or `max`.                                                                                                                                                       |
| `name`          | 1 to 120 characters, with no control, line-break or text-direction characters and no leading `-`.                                                                                                                  |

No value can start with `-`, so none can become one of pi's flags. A file that
one of this Host's sessions is running on is not started twice: a second start
is refused, even one racing the first, and a file a session may be moving to
counts too (see [Session commands](#session-commands)). A deletion names only
`repository` and `sessionPath`. It refuses a running session, cancels a start of
the same file still under way, and unlinks only one of pi's session files: a
regular `.jsonl`, not a link, directly in a folder of pi's session root. All of
this holds within one Host process: a pi that Desktop or another process runs on
the same file is not seen. Ownership across processes is component 06's.

### Session commands

A running session takes pi's RPC commands, except these, so that the Host
always knows which file each pi writes:

- `new_session`, `switch_session`, `fork` and `clone`. Each moves pi to another
  session file, and only a request starts or resumes one.
- `export_html` with an `outputPath`. An export goes where pi puts it.
- Any type that is not one of pi's.

A prompt that starts with `/` can run an extension command, and that can move pi
to another file. pi answers such a prompt only once the command has finished,
failed or not, and the Host then asks pi which file it writes. From the prompt
until that answer, it admits no resume and no deletion, of any file: each is
refused, to be tried again. A new session is never held up, since its file is
new. An extension that moves pi after its command has ended is followed only
from that session's next prompt.

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
anyway, and which commands a remote controller may send is component 21's.

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

`${XDG_STATE_HOME:-~/.local/state}/phosphor-host/logs/phosphor.log`, rotating at
5 MB like Desktop's. The folder is 0700 and every file 0600, an older folder,
log or rotated log included. It records the runtime's inputs (pi's command, the
names in pi's environment, PATH, the repositories), each spawn's argv, pi's
stderr, unexpected exits, state changes and drain results. Every string is
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
