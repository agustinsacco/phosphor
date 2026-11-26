# This Mac’s Phosphor service

On packaged macOS and Linux builds, This Mac’s lanes run in the Phosphor service: the Host as a per-user launchd agent (macOS) or systemd user unit (Linux). Quitting Desktop does not stop them. Windows keeps the in-app runtime; development builds install no service. Desktop decides the runtime once per launch, in `local-machine/launch.ts`.

- **A new install** starts in-app. Its first launch installs the service in standby, and the next launch moves This Mac to it with the same one-time migration, which has little or nothing to move.
- **An existing in-app install** does the same when a compatible signed release is available: standby install while in-app, then the one-time migration of its lanes, routines and device state at the next eligible launch ([Handing over existing lanes](#handing-over-existing-lanes)).

Both the signed v2 manifest and the staged program must advertise `local-mode` and `owner-socket`; an older bundle does not trigger the move. After the move Desktop stays in service mode and never falls back to in-app; only the [break-glass restore](#break-glass-restore) returns to it. **Settings → Advanced** shows the state and offers recovery actions. A service installed before the [Standard priority](#installation-and-launch) default needs a one-time reinstall to get it.

Opening a stopped service lane starts pi in the background while you type. The service
advertises this policy on both the owner socket and its enrolled connection. Only the opened
lane warms; a paused lane or one held by another controller stays stopped. The
client checks the fresh view after opening the lane; it does not wait for pi
before showing the transcript and [saved composer readings](chat.md).

## Installation and launch

Desktop checks for a compatible service release at startup and periodically. It pairs using `setup --local --standby`, without enrolling the machine. The public owner key goes to the service; the private key on disk requires protected storage. Desktop leaves a foreign launcher alone. If an installed release was never set up (no config and no launcher), Desktop installs a newer release over it before trying setup again, so a fixed release reaches a Mac whose first setup failed. A release that was set up updates only through `phosphor update`. While in-app, **Settings → Advanced** shows the install (checking, downloading, setting up, installed, or the failed check and its reason), and `phosphor.log` records each change as `service install`. Standby exposes the [owner socket](remote-protocol.md#the-local-socket) but runs no lanes, scheduler, heartbeat or TCP API.

On macOS, a new service uses launchd’s `Standard` process type for the Host and
its pi children. An existing `Background` service keeps that priority after a
Host update or Desktop migration. Local setup leaves a loaded service alone.
To reinstall after updating, finish active work and quit Desktop. In an external
terminal, signed in as the same macOS user and without `sudo`, set PATH,
`XDG_CONFIG_HOME` and `XDG_STATE_HOME` to the values in the installed job's
`EnvironmentVariables` (unset if absent), then run:

```sh
~/.local/lib/phosphor-host/current/bin/phosphor service uninstall &&
  ~/.local/lib/phosphor-host/current/bin/phosphor service install
```

`service uninstall` removes the loaded job and plist, not the release, config,
identity or lane data. `service install` reports only that launchd accepted the
job, so reopen Desktop and confirm the service card shows it connected. If it
does not start, read the service log and run `service install` again with the
same config and state folders; do not run setup again. `service status` can exit
nonzero for a healthy local service that is not enrolled.

`local-machine/launch.ts` decides the runtime once, after IPC registration and before pi configuration, windows or sessions. An unpackaged build needs both `PHOSPHOR_TEST_USER_DATA` and `PHOSPHOR_MIGRATE=1` to migrate. Dev over data already committed to the service cannot start in-app lanes if it cannot reach the service.

## Handing over existing lanes

1. Desktop checks its installation record, the pi agent directory’s owner lock, migration journal and the running service’s features and standby state. If Desktop finds a service that already owns lanes and it has in-app data to move, it asks for explicit merge consent in **Settings → Advanced**. Stop that service’s live lanes first; release refuses while even one lane has a pi process. Consent and Retry take effect on relaunch.
2. Before commit, Desktop backs up device state, plans the import and verifies the staged result. Service sections cover folders, policy, accounts, lanes, marks, archives, artifacts and routines. Every lane in a moving folder moves except a routine's, including rewind predecessors the sidebar folds, so the service links and folds them the same way rather than finding them again as new lanes. Desktop sends no model for a lane, so the service reads each moved lane's model from its transcript, the way the Host's [start-up repair](host.md#state) does. Import is keyed by migration ID and section hash; failures before the commit point can abort and restore staged state. Folder or lane counts over the legacy limits keep This Mac in-app; migration does not silently select a subset.
3. `commit-requested` is the point of no return for automatic recovery. On restart Desktop checks the service’s migration status: it resends a staged commit, finishes one already committed, and reports a lost commit rather than starting an in-app writer. An unexpected error while the gate is deciding or migrating falls back by journal: unreadable, commit-requested or committed means daemon mode with the service down; otherwise in-app.
4. Desktop re-keys drafts and sidebar preferences to service identities; the plan maps alternate folder spellings to the repository ID. Marks belong to service lanes. It clears the legacy recents and last session and moves the old routines database aside, so an older Desktop does not automatically reopen the same work. On daemon-mode launch it waits up to ten seconds for the last service lane to appear before giving up on reopening it.

Routine-owned sessions stay out of the lane list. The service reads a run’s output from the session file recorded in its imported history. This also works after a previously committed move: updating the service and client is enough. No backup restore or repeat migration is needed.

## Using the service

The service owns the lanes, routine scheduler and [artifact library](remote-desktop.md#remote-artifacts). Quitting Desktop does not stop those lanes. Skills, routines, machine settings and artifacts scoped to **This Mac** use the service connection; a disconnected service shows unavailable, not the frozen in-app data. Device UI and [Brain](brain.md#recall) still live in Desktop, including Brain Agent's private [Brain lane](brain.md#brain-agent), the one lane Desktop starts itself. Machine IPC routes are enumerated by `@phosphor/shared/ipc-local-route`; same-machine file operations resolve local lane/folder keys, and destructive workspace maintenance takes an owner lease. The service refuses lane starts and restores in a leased workspace.

Signing in can enroll the service over the owner socket without restarting lanes. Desktop checks the account-side fingerprint before approving; an account mismatch is not permission to re-enroll. Signing out leaves the service enrolled. Desktop keeps the local socket slot, not a second connection to the enrolled directory entry.

In **Settings → Advanced → Software**, **Update…** stages a signed release and waits for working turns, live sub-agents and routines. **Stop turns and update now** saves and stops unfinished turns; **Cancel update** leaves the service on the same version. A wait that times out stops nothing. Settings stays mounted during the restart and shows success only when the version changes; the same pipeline appears for a remote Host in Desktop and the PWA. A genuine outage outside an update still offers **Start service** or **Retry**. A failed move offers **Retry** or **Export diagnostics** (status-only JSON).

The owner socket reports the most recent update result. Desktop projects it into its optional local-machine status field so Settings can distinguish a rollback from a stale result.

## Break-glass restore

`--restore-in-app-runtime` is recovery from a **committed** migration, not a runtime selector. Stop the service’s lanes first. Desktop asks the identified service to release ownership and waits up to 60 seconds for standby with a free lock. A refusal or unconfirmed release shows an error and quits without restoring data. Restore uses the pre-migration device settings and routines, not subsequent edits; a draft image no longer on disk is not reconstructed. The journal becomes `reverted`; automatic migration stays blocked until Retry. A migration after Retry keeps the lane IDs the service already has, so links and marks to those lanes still resolve. See [service limits and recovery risks](known-issues.md#this-macs-service).
