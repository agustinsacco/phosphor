# Rehearse This Mac's migration (operator only)

**Do not run on live data without owner approval.** This is a one-shot measurement on a private **copy**, not a backup, installer, restore tool or CI job. No app or service needs to be stopped. Use a quiet interval; if anything changes, discard scratch and start over. Use a trusted, isolated checkout and builds. Do not share scratch, edit its files or run another program against it.

## Commands

From the root of the approved checkout on macOS, with its dependencies already installed and Command Line Tools (`/usr/bin/python3`) available. Build an **unpackaged** Desktop, not the release package. The Host from the same revision must advertise both `local-mode` and `owner-socket`. Base `46846148f` does not: expect **exit 1**, `host-features-missing`. Desktop's unpackaged feature override stands in for `service.json` only; it cannot force a real service through the gate.

```sh
set -eu
umask 077
export PATH="$HOME/.local/share/fnm/node-versions/v22.23.4/installation/bin:$PATH"
export TMPDIR=/tmp                   # short macOS Unix socket; checked against system temp
R0=tools/migration-rehearsal
SCRATCH="$(node -p 'require("node:fs").mkdtempSync("/tmp/r0-")')"
node "$R0/assert-scratch.mjs" --scratch "$SCRATCH"
npm run build --prefix apps/desktop
node "$R0/prepare.mjs" --scratch "$SCRATCH" \
  --source-user-data "$HOME/Library/Application Support/Phosphor" \
  --source-agent-dir "$HOME/.pi/agent"
node apps/host/scripts/build.mjs --out "$SCRATCH/host"
node "$R0/run.mjs" --scratch "$SCRATCH"          # add --full for the restore cycle
```

`--full` goes on after the move commits, as a person would: Desktop again on the service, lanes listed with the `phosphor` CLI (the service must hold exactly the moved lanes and archives, and the sidebar must show what it showed before), the newest non-Claude lane started and every lane stopped through the CLI, then `--restore-in-app-runtime` with a launchd-style restart after exit 75, and Desktop in-app once more. It checks the restored folders, Claude accounts, routines and runs against the backup, that no second move starts, and that every transcript is still there and none shrank. A check the copy cannot exercise reports `skipped`: the copy has pi's settings but not its packages, so Claude lanes cannot start.

Retain only the redacted run summary. After success **or failure**, delete this private scratch, including the transcripts, path-bearing manifests and throwaway fixture keys. With `SCRATCH` still set by the command above:

```sh
node "$R0/assert-scratch.mjs" --scratch "$SCRATCH" && rm -rf -- "$SCRATCH"
```

## What is copied

- userData: `config.json`, `routines{,-dev}.sqlite` plus their `-wal` and `-shm`, `lane-archive/`, `drafts/` (images), `artifacts/`, `daemon-migration/`. `claude-accounts/` gets an empty directory per account; no entries inside an account directory are enumerated.
- Agent: `sessions/` and `settings.json` only. For everything else (including `packages`, `npm`, `scratch`, Chromium data), record the top-level name **without descending**. Secret filenames such as `auth*.json`, `.env*`, `*.pem`, `models.json` and names containing `credential` or `keychain` are excluded at any depth. This is a file filter, **not a content scrubber**: transcripts, preferences, settings and artifacts remain private.
- `before.json` and `after.json` list the relative names, file identities, times and SHA-256 of every included regular file, `excluded` names and `standIns`. They are for private inspection only. Each file is cloned from an identity-checked read-only descriptor on Darwin (`fclonefileat`); unsupported/cross-volume clones use a streamed exclusive copy. The counts distinguish those cases. Each target must have a separate inode and the expected digest. Only a successful comparison publishes `prepared.json`.
- The tool opens **no source file for writing**. Manifests detect observable changes; they do not attest to other processes' open flags, detect an open without writes, or create a point-in-time filesystem snapshot. Big trees require multiple complete reads even on APFS. Excluded contents aren't fingerprinted.

## Run boundary and evidence

- Exit **99** from `assert-scratch` or the initial run guard: the named scratch is not an owned, private `r0-XXXXXX` direct child of the system temp directory, a root escapes or is linked, or the socket is too long. The checked layout includes userData, agent, config, state, socket, runtime, HOME, owner key, LaunchAgents and systemd units. Roots are derived, not independently configurable.
- Preparation refuses overlapping sources/scratch, nonempty scratch, links, multiply-linked files and special files at copy inputs, source drift and verification failures (exit 1). Run requires a successful preparation, a fresh Host build under scratch and no prior journal, links, special files, leftover daemon state or previous run. It refuses CI and non-macOS. No resume/retry in a used scratch.
- The foreground fixture is unenrolled and starts in standby, with shell capture and Headroom off, pi stubbed, a generated scratch-only owner pairing and no service installation. Desktop uses the E1 owner-socket/config/key environment plus `PHOSPHOR_MIGRATE=1`, `PHOSPHOR_TEST_USER_DATA`, `PHOSPHOR_E2E_SERVICE_FEATURES` and the keychain-off hook. Children do not inherit the caller's environment.
- Both children **require** `sandbox-exec`: direct writes are restricted to scratch and socket networking to the one checked Unix socket; there is no way to run them outside it. Desktop gets Chromium's `--no-sandbox --disable-gpu`, because Chromium's own sandbox cannot start inside Seatbelt; `sandbox-exec` remains the fence. Read-only workspace scans may see real repository paths embedded in preferences; protected source data, auth directories and TCC folders are not used as substitutes for missing copies. The checkout itself must remain readable. Preparation points the scratch copies of `config.json` and `lane-archive/*.json` at scratch (resolved `<scratch>/user-data` and `<scratch>/agent`), as the real migration sees them at home; nothing else is rewritten. Prepared from a staged copy, pass `--recorded-user-data` and `--recorded-agent-dir` with the paths the files record. Missing/lost references, excluded sandbox repositories and empty account stand-ins can still affect plan counts or gates. Check counts against expectations; a commit alone isn't proof of parity.
- Stdout is a summary, not a log dump: state, failure step, verify-gate results, expected plan counts, milliseconds since the preceding recorded step and total elapsed milliseconds. A done `verify` means the verification routine accepted its gates (G11 uses its normal default when no device port is installed); on failure only the named failed gate is singled out, others stay unverified. No journal/plan means no counts. Missing daemon readiness (30 s), a missing or incomplete terminal journal (180 s total), a failure or an unreadable record is unsuccessful. Exit **0** requires a committed journal with verify, device, quarantine and done recorded. Only this run's child process groups are stopped.

## Scratch-only checks (no app or Host)

```sh
npx tsc -p tools/migration-rehearsal/tsconfig.json
npx vitest run --config tools/migration-rehearsal/vitest.config.mjs --maxWorkers=2
```
