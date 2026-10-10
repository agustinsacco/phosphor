# The Host

The Host is Phosphor's plain-Node application for machines Desktop does not run
on. Its command is `phosphor`; its config and logs live in `phosphor-host`
folders, apart from Desktop's own. Today it is a foreground CLI that checks
whether a machine can run sessions. Its session runtime is built and tested
([Sessions](#sessions)), but no command starts a session yet, and it listens on
nothing. `npm run build:host` builds it ([Build](#build)); nothing installs or
publishes it yet. Desktop never runs a Host, and offline Desktop never needs one
([remote-access.md](remote-access.md)).

The source is `apps/host/src/`. It imports Node builtins and the exported
subpaths of `@phosphor/session-runtime` and `@phosphor/shared`, nothing else:
ESLint refuses Electron, `@shared/*` and `@/*`, and `boundary.test.ts` checks
every library import against the package's exports.

## Commands

```
phosphor doctor [--config FILE] [--json]
phosphor version [--json]
```

stdout carries only the report or the JSON. Usage errors go to stderr.
`version` prints `0.0.0-dev.<sha7>`, or `0.0.0-dev.source` when the build did
not stamp a commit.

| Exit          | Meaning                                                                  |
| ------------- | ------------------------------------------------------------------------ |
| 0             | success                                                                  |
| 64            | usage error                                                              |
| 69            | a prerequisite is unavailable: node, pi, git, extensions or a repository |
| 70            | internal error                                                           |
| 78            | the config is invalid                                                    |
| 129, 130, 143 | ended by SIGHUP, SIGINT or SIGTERM, after killing any running probe      |

## Build

`npm run build:host` writes `apps/host/dist/`, which git ignores. It runs
`node apps/host/scripts/build.mjs`, which also takes `--out DIR` and `--sha SHA`:

- `phosphor.mjs` and its linked source map: one ESM file for Node 22, built by
  esbuild from `src/main.ts`. Run it as `node phosphor.mjs <command>`.
- `pi-ext/`: the bundled extensions, copied with Desktop's filter (every `.ts`
  file but tests). A session loads them from beside the bundle unless the config
  sets `resourceRoot`.
- `BUILD-INFO.json`: the version, the source commit, whether the tree had
  uncommitted changes, the Node target, and every file with its size and sha256.

The version is `0.0.0-dev.<sha7>` of the source commit, HEAD unless `--sha`
names another. The build fails if the bundle reaches Electron, `electron-store`,
`electron-updater`, `node-pty`, Desktop or the site, imports anything but a Node
builtin, or lacks one of the six extensions. It builds in a new folder beside
the output and moves it into place only at the end, so a failure leaves the
output as it was and removes only what the build made. It only replaces an empty
folder or an earlier build: a real folder whose `BUILD-INFO.json` is a regular
file naming `phosphor`, schema 1, that lists every other file in it. Anything
else, a link inside included, is refused and left alone. Nothing is signed; real
versions and signed bundles are component 23's.

`bundle.test.ts` builds into a scratch folder and checks `BUILD-INFO.json`
against the files, the imports, and `pi-ext/`. It then runs the built file under
a minimal environment (`HOME`, `USER`, `LOGNAME` and `PATH=/usr/bin:/bin`):
`version`, and `doctor` on the extensions beside it.

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
  "accounts": null
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

| Field              | Meaning                                                                                                                                    |
| ------------------ | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `hostId`           | Optional. Defaults to the short hostname, made to fit the HostHello identifier pattern.                                                    |
| `pi.executable`    | What `command -v pi` prints.                                                                                                               |
| `pi.node`          | The node that runs pi. Required when `pi.executable` resolves to a Node script, as pi 0.87.1 does.                                         |
| `resourceRoot`     | Holds `pi-ext/`. Defaults to the running bundle's own folder.                                                                              |
| `repositories`     | 1 to 64 folders that sessions may run in. Never `/`.                                                                                       |
| `contextBudget`    | Desktop's grammar; `""` or absent is the 200k default. A value Desktop would quietly replace with the default, such as `77k`, is an error. |
| `environment.pass` | Up to 64 more variable names for pi. Names only, never values. Naming `PATH` or a hook below is an error.                                  |
| `environment.path` | Up to 32 more PATH folders.                                                                                                                |
| `accounts`         | `null` or absent: accounts are unavailable on a Host.                                                                                      |

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

| Check                     | Rule                                                                                                                                                                                                                                                                                                                | On failure |
| ------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---------- |
| `host-node`               | The node running the Host is 22.19.0 or newer, as npm orders versions: a 22.19.0 prerelease is older.                                                                                                                                                                                                               | 69         |
| `config`                  | Found, owned as above, parsed and valid. doctor stops here when it is not.                                                                                                                                                                                                                                          | 78         |
| `environment`             | Warns about ambient authority, and about passed names the Host's environment does not have.                                                                                                                                                                                                                         | warning    |
| `hello`                   | The HostHello holds no secret value of pi's environment. One that would is never shown or presented; the check names the field and the variable, never the value.                                                                                                                                                   | 78         |
| `pi-node`                 | An executable file whose `--version` satisfies pi's `engines.node` as npm checks engines, prereleases included: npm comparators (`>=`, `^`, `~` and the rest) joined by spaces and `\|\|`. A range with any other part, such as `22.x`, or one that is not a string, fails. 22.19.0 or newer when pi declares none. | 69         |
| `pi`                      | A Node script needs `pi.node` (78). `--version` is 0.87.1 or newer and matches pi's own package.json when it has one.                                                                                                                                                                                               | 69         |
| `git`                     | `git --version` succeeds for the first `git` on pi's PATH.                                                                                                                                                                                                                                                          | 69         |
| `extensions`              | The six bundled extensions, and every helper they import from beside themselves, are under `<resourceRoot>/pi-ext/`.                                                                                                                                                                                                | 69         |
| `repository`              | Each root resolves to an existing folder other than `/`. A root holding the home folder, or one level under `/`, warns; one that is not a git repository is noted.                                                                                                                                                  | 69         |
| `agent-dir`               | pi's agent folder exists, meaning pi has run as this user.                                                                                                                                                                                                                                                          | warning    |
| `context-budget`          | The budget sessions will be held to.                                                                                                                                                                                                                                                                                | never      |
| `accounts`, `compression` | Unavailable on a Host: pi uses the logins of the user running it, and there is no Headroom proxy.                                                                                                                                                                                                                   | never      |

Two lanes come out of the checks:

- **native** is available when no check failed.
- **claude** needs the native lane, `@saccolabs/pi-claude-cli` 0.10.0 or newer in
  pi's global packages (the gate Desktop uses, `claudeContextProviderShortfall`),
  and a `claude` on pi's PATH that `claude auth status` reports logged in. Only
  `loggedIn` is read from that output, and a failure is described from stderr
  alone: the email and organization beside it identify a person.

`--json` adds `hello`, the HostHello this Host would present: its host id and
version, protocol 1, a `runtimeEpoch` that is new on every run, and the
capabilities `sessions.read` and `sessions.control`. It is checked with
`validateHostHello` before it is printed, and left out when it would show a
secret value (the `hello` check).

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
because a terminal's Ctrl-C does not reach another process group.

## Sessions

`session/runtime.ts` composes the session runtime for this machine:
`createHostRuntime` takes what doctor validated and binds every port the
library asks for. No command calls it yet; `accept` will be the first.

- **One service, one lock domain.** Starts, resumes and deletions go through
  the library's service and deletion, which share one registry and one
  path-lock domain, as on Desktop.
- **pi as pinned.** pi starts from `pi.node` and `pi.executable`, never a stub,
  with exactly the environment built above plus `PI_CLAUDE_CLI_CONTEXT=pi`:
  nothing the Host inherited reaches it. It loads the six extensions from
  `<resourceRoot>/pi-ext/` and leads its own process group.
- **Fixed policy.** The default agent directives, with no per-project
  overrides; pi's own settings for the default provider, and pi's packages for
  the Claude gate; the config's context budget, never paused. There are no
  accounts, no Headroom, no routines and no recents.
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
