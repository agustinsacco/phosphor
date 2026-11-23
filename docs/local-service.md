# This Mac’s Phosphor service

Packaged Desktop automatically moves This Mac’s lanes to the service **once**, when a compatible signed release is available. It installs the service in standby while still running in-app, then migrates at the next eligible launch. Both the signed v2 manifest and the staged program must advertise `local-mode` and `owner-socket`. An older bundle does not trigger the move. **Settings → Advanced** shows its state and offers recovery actions.

## Installation and launch

Desktop checks for a compatible service release at startup and periodically. It pairs using `setup --local --standby`, without enrolling the machine. The public owner key goes to the service; the private key on disk requires protected storage. Desktop leaves a foreign launcher alone. Standby exposes the [owner socket](remote-protocol.md#the-local-socket) but runs no lanes, scheduler, heartbeat or TCP API.

`local-machine/launch.ts` decides the runtime once, after IPC registration and before pi configuration, windows or sessions. An unpackaged build needs both `PHOSPHOR_TEST_USER_DATA` and `PHOSPHOR_MIGRATE=1` to migrate. Dev over data already committed to the service cannot start in-app lanes if it cannot reach the service.

## Handing over existing lanes

1. Desktop checks its installation record, the pi agent directory’s owner lock, migration journal and the running service’s features and standby state. If Desktop finds a service that already owns lanes and it has in-app data to move, it asks for explicit merge consent in **Settings → Advanced**. Stop that service’s live lanes first; release refuses while even one lane has a pi process. Consent and Retry take effect on relaunch.
2. Before commit, Desktop backs up device state, plans the import and verifies the staged result. Service sections cover folders, policy, accounts, lanes, marks, archives, artifacts and routines. Import is keyed by migration ID and section hash; failures before the commit point can abort and restore staged state. Folder or lane counts over the legacy limits keep This Mac in-app; migration does not silently select a subset.
3. `commit-requested` is the point of no return for automatic recovery. On restart Desktop checks the service’s migration status: it resends a staged commit, finishes one already committed, and reports a lost commit rather than starting an in-app writer. An unexpected error while the gate is deciding or migrating falls back by journal: unreadable, commit-requested or committed means daemon mode with the service down; otherwise in-app.
4. Desktop re-keys drafts and sidebar preferences to service identities; the plan maps alternate folder spellings to the repository ID. Marks belong to service lanes. It clears the legacy recents and last session and moves the old routines database aside, so an older Desktop does not automatically reopen the same work. On daemon-mode launch it waits up to ten seconds for the last service lane to appear before giving up on reopening it.

## Using the service

The service owns the lanes, routine scheduler and [artifact library](remote-desktop.md#remote-artifacts). Quitting Desktop does not stop those lanes. Skills, routines, machine settings and artifacts scoped to **This Mac** use the service connection; a disconnected service shows unavailable, not the frozen in-app data. Device UI and [Brain](brain.md#recall) still live in Desktop. Machine IPC routes are enumerated by `@phosphor/shared/ipc-local-route`; same-machine file operations resolve local lane/folder keys, and destructive workspace maintenance takes an owner lease. The service refuses lane starts and restores in a leased workspace.

Signing in can enroll the service over the owner socket without restarting lanes. Desktop checks the account-side fingerprint before approving; an account mismatch is not permission to re-enroll. Signing out leaves the service enrolled. Desktop keeps the local socket slot, not a second connection to the enrolled directory entry.

In **Settings → Advanced → Phosphor service**, use **Start service** or **Retry** when unavailable. A failed move offers Retry or **Export diagnostics** (status-only JSON). **Update Phosphor service** stages a release, waits for working lanes, live sub-agents and routines to pause, then applies the staged version. While waiting, **Abort now** saves and stops unfinished turns; **Cancel** leaves the update unapplied. Timing out does not abort turns. An update starting is not confirmation that the version changed. The browser has no same-machine service card.

## Break-glass restore

`--restore-in-app-runtime` is recovery from a **committed** migration, not a runtime selector. Stop the service’s lanes first. Desktop asks the identified service to release ownership and waits up to 60 seconds for standby with a free lock. A refusal or unconfirmed release shows an error and quits without restoring data. Restore uses the pre-migration device settings and routines, not subsequent edits; a draft image no longer on disk is not reconstructed. The journal becomes `reverted`; automatic migration stays blocked until Retry. See [service limits and recovery risks](known-issues.md#this-macs-service).
