# Remote access

Desktop routes remote lanes over the authenticated Host connection. The Host API
serves remote lanes when pi is usable. Local Electron still needs no Phosphor login.
Desktop has an optional GitHub sign-in in the sidebar footer
([settings.md](settings.md#phosphor-account)). Machines is always available,
with this computer's real status. Signed in, it lists enrolled Hosts and lets
a person approve a Host code, rename or remove a machine
([ui-shell.md](ui-shell.md#machines)). Signed out, it shows no sample Hosts.
Enrollment is not an execution grant.
The contract, schema, Host enrollment commands and Desktop approval clients exist.
`apps/control` is the combined site and API server, but it is not deployed yet.
It serves enrollment, the machine directory and Host routes, proven end to end
against a local Supabase stack (`npm run test:control-stack`). Control never
proxies lane contents or execution. The grant-authenticated Host API is separate.

## Contract and clients

`libs/shared/src/control-api.ts` fixes bounded wire shapes, parsers, error codes,
enrollment codes, heartbeat status rules and the byte-exact Host signing string.
`libs/shared/src/remote-host.ts` validates hello compatibility and enrolled Host
identity and builds host-qualified resource keys. Hello validation is not
authentication, and these helpers do not migrate Desktop's local stores.

The [control server](control-plane.md) serves built Astro pages, health, account
metadata, enrollment, the machine directory and Host routes. That doc owns its user and Host authentication ports,
configuration and route boundaries. The server never probes a submitted machine
endpoint or relays execution.

The [Host CLI](host.md#machine-identity) implements `phosphor login`,
`status [--json]` and `logout [--local]`. Login creates a key on the Host, prints
a code and fingerprint, polls for approval and saves the identity. Status checks
the server; logout requests self-revocation. `--local` only forgets locally.
The Host doc owns pending-state recovery and identity storage. These outbound
signed clients do not open a listener or start a heartbeat loop.

Desktop's main-only control client supplies machine listing, code lookup,
approval, rename and removal through typed IPC. The guided approval compares the
fingerprint and asks for a label. Removal is confirmed and is not uninstall.
Realtime changes trigger a debounced refetch, with a 60 s fallback while
disconnected. A local 5 s timer judges up/down using the server clock offset.
Tokens stay in main. See [settings.md](settings.md#phosphor-account) and
[ui-shell.md](ui-shell.md#machines) for the UI contract.

## Desktop Host connections

Main keeps one authenticated socket per up Host with a bare HTTPS `.ts.net`
origin, up to 32 sockets. It follows account and machine-directory changes.
Sign-out or account change closes sockets and clears remote memory. Down Hosts
retain their last-known lane summaries in memory only. Removing a Host drops
its cache. Endpoint changes close the old socket before opening another.

Client ids live in a separate main-only electron-store, one per account with
at most eight entries. An unknown or revoked client refusal permits one
replacement registration per user per app run. Only sign-out or switching
accounts resets that budget, not a forbidden refusal or a directory refresh.
Grants are cached only until their renewal time. Main verifies each Host's
challenge proof with its enrolled public key before trusting its ready frame. Connections renew grants and send text keepalives.
Transient failures reconnect with bounded backoff. Forbidden access and an
unsupported protocol stop retries; a wrong-machine proof stops until the
machine directory changes. Oversize closes query receipts rather than resend
commands. Other reconnects resend unchanged commands under 60 seconds, then
ask receipt status. Replay waits for queue space in original order, rechecking
that age rule on each retry. New sends answer `not-connected` until replay drains.
Unknown means the action's outcome remains uncertain.
Local `not-sent` results (`too-large`, `too-many-pending`, `not-connected` or
`closed`) never write or queue a command. `not-connected` is transient; callers
may try a fresh action once ready. `closed` means no automatic retry.

`hosts:snapshot` exposes `no-address`, `connecting`, `ready`, `reconnecting`,
`wrong-machine`, `unsupported` and `signed-out` states. `hosts:changed` is a
250 ms debounced refetch signal. Controllers expose only a label, connection
status and whether they are this Desktop, never a client or user id. Repositories,
lane summaries, cursors, the last 50 attention events and open lane streams stay
in memory. No transcript is written to the client's disk. Remote lane access
requires `sessions.read` in the Host's authenticated `ready` frame; mutations
also require `sessions.control`.

`hosts:openLane` returns one opaque `remote-<16 hex>` handle per lane per window,
with at most 64 handles per window. Its workspace key is
`host:<hostId>/<repositoryId>`, never a local path. Opening marks the lane read.
`hosts:createLane`, `hosts:stopLane`, `hosts:resumeLane`, `hosts:takeControl` and
`hosts:markRead` send bounded, validated Host commands. Taking control is always
explicit. Handles are private to their window and disappear on window close,
sign-out, account change or Host removal. Down Hosts retain memory-only views.

Main routes remote `pi:command`, `pi:extensionUiResponse` and
`pi:disposeSession` without consulting the local pi registry. The allowlist is
`electron/hosts/lane-ops.ts`. Receipts become pi responses; controller rejections
name the machine and controller. Unknown outcomes tell the user to check the lane
before retrying. Unanswered commands expire after 60 seconds as unknown, never
as a fresh retry. Local pi routing is unchanged.

Remote snapshots and reset snapshots replace main's in-memory lane projection.
Main sends `resync` on the handle's usual pi event channel. The renderer obtains
state and messages through the existing hydrate path. Until the messages reply,
main holds live pushes and serves the frozen snapshot. After that reply it sends
the snapshot's pending events and UI, open dialogs, then held pushes, in order.
The hold is bounded by the stream event and byte limits; overflow starts a new
resync. Without a messages query it flushes after ten seconds. Live pi events
otherwise pass through unchanged. Reconnect subscriptions carry the last cursor;
a new epoch or reset starts hydration again. Dialog resolution resyncs viewers
without the answered dialog.

Attention publishes `hosts:attention` and a machine-titled OS notification for
lanes not focused in any focused window. Notifications are deduplicated in
bounded memory. Clicking focuses a window and sends `hosts:openLaneRequested`.
`hosts:setFocusedLane` tracks each window's active remote lane, or null for a
local lane. Read counters come from the Host and clear unread across clients.

`IPC_SCOPE` classifies every invoke channel as app-local or machine-scoped.
Unrouted machine channels reject opaque remote workspace keys and remote handles,
including nested options, with “Not available on remote lanes yet.” They never
fall through to this machine's filesystem or subprocesses.

## Remote read panes

Remote Files and Changes require `workspaces.read` in the Host's ready frame.
Files lists tracked and untracked non-ignored paths and opens text read-only.
Changes shows git status and an inline read-only diff against HEAD. Binary files
and oversized text use placeholders. These panes never mount local editors,
preview protocols, filesystem watchers or file management actions. They refresh
on focused lane summary changes (including turn end), reconnects and manual refresh.
Streamed text does not reload the pane. Added and untracked files use an empty
original. If HEAD cannot be read, its placeholder does not discard current text.

Main routes only `fs:listFiles`, `fs:readFile`, `git:statusMap`, `git:showFileAt`,
`skills:list` and `skills:readFile` to the read features, and only when the call
names a `host:` workspace. A call with no workspace, such as the global model catalogue,
stays local even while a remote lane is focused.
The live chat picker keeps the lane's full pi model list through `lane.models`,
requiring `sessions.read`. Stopped lanes do not fall back to a machine catalogue.
Skills requires `skills.read`. Remote Skills shows the installed list
and SKILL.md read-only, with no export, upload, discovery installs or mutations.
Unsupported panes retain the not-available state. All writes remain refused.

Workspace reads resolve through the window's focused open lane. The opaque
workspace key must match that lane, so two worktrees in one repository are not
chosen by repository id alone. Without a focused lane, remote reads fail closed.
File and skill keys contain no Host filesystem root. Main validates params and
parses every feature result with the shared bounded parsers, and rechecks the
connection and capability after each reply. Errors expose only fixed text.

## Remote artifacts

The lane's Artifacts pane requires `artifacts.read` in the Host's ready frame.
Main uses the lane handle, never a session file path, to fetch metadata and each
current-branch version. A call caps total content at 8 MiB and each version at
2 MiB, with at most 1,000 version reads per call. Invalid replies, changed
connections, revoked capability or a changed
focused lane fail closed. The renderer discards stale replies.

The global Artifacts library includes local artifacts and artifacts from ready
Hosts announcing `artifacts.read`, tagged with the machine label. Remote library
keys name opaque lane/slug resources, not Host session ids or filesystem paths.
A failing machine is absent from the listing; local rows and other machines still load.
Stored remote rows open read-only in the library; live rows can open their lane.
Removed lanes are excluded because no admitted lane authorizes their read.
Local deleted-session retention is unchanged. Host indexes and blobs stay on
the Host; Desktop holds remote contents in memory only.

HTML staging remains local through `phosphor-artifact://`. Its sandbox never
uses `allow-same-origin`, and its policy grants no network access.

## Host protocol

`libs/shared/src/host-protocol.ts` defines protocol v1, its allowlist, parsers
and limits. The Host serves hello and grant authentication on `/v1/hello`
and `/v1/stream`, on loopback port 47615 (configurable as `api.port`). It
announces session capabilities only when supplied a lane service. Without it,
the API remains authentication-only. The network adapter multiplexes authenticated
subscriptions, commands, receipt status and calls over each socket. Adapter tests
use a fake lane service and loopback sockets. The contract kit also runs every
scenario against the real in-process Host with a temporary SQLite store, signed
grants and a scripted runtime port. The fake Host passes the same suite. A separate
fake-pi subprocess test proves runtime startup, streaming, stop, resume and drain.
Tailscale Serve can expose the loopback listener, never Funnel.
[Host API](host.md#api) owns its admission, limits and close codes. [Trust boundary](#trust-boundary) and
[Host machine identity](host.md#machine-identity) apply to this protocol too.

Host, lane, client and request ids are UUIDs. Repository ids, connection ids
and process epochs are 16 lowercase hex characters. Lane ids survive restarts;
stream cursors do not. A cursor names the epoch and last event held, with 0
meaning none. A new epoch or replay gap requires a snapshot. Lane events are
ordered by the Host, not by Desktop or control. Snapshots include settled
messages, in-flight events, dialogs and the latest status, widget and title
state. stderr never crosses the wire.

Text frames carry one JSON object. `auth` establishes or renews permission;
`ready` proves the enrolled Host with a challenge signature. `subscribe` and
`unsubscribe` manage lane summaries and individual lane streams. `call` and
`result` are read-only. `command`, `receipt` and `receipt-status` handle
mutations. The persisted control fence rises on takeover or release. Only the
controller can mutate a lane with its current fence. The first mutation of an
unowned lane acquires control and raises the fence before pi events. Every
viewer sees control changes at the same stream position. Disconnecting does
not release control.
A request id deduplicates one action. Receipts are pending, done, failed,
rejected or unknown. Unknown means the outcome is uncertain, not permission to
repeat the action with a new id. A pi command unanswered after 30 seconds becomes
unknown; a later completion cannot replace it or send another terminal receipt.

`HOST_LIMITS` caps inbound frames at 8 MiB, outbound frames at 16 MiB,
subscriptions at 64 per socket, pending commands and in-flight calls at 32 per
socket, and receipt interest at 64 ids. Excess commands are rejected without
submission; excess calls close 4429. The oldest status interest is dropped first.
Execution receipts fan out only to interested sockets of the originating client;
attempt replies are socket-local and conflicts leave the original interest intact.
Losing read capability on renewal ends subscriptions and suppresses outstanding
call answers. A later regain permits new subscriptions. Replay,
queues, UI keys and receipt retention are bounded too. Oversize subscriptions
end with `too-large`, not a closed socket; oversize call results answer
`too-large`. Replay stops when an oversized event becomes a reset snapshot or the
subscription fails; older events never follow the reset. A slow subscription
resumes with one reset snapshot. Close codes
are 1001 for shutdown, 4400 for malformed client frames, 4401 for missing or
expired auth, 4403 for forbidden access, 4409 for incompatible protocol and
4429 for excess requests or connections.

`@phosphor/shared/host-protocol-testing` exports the asynchronous bounded
loopback transport, fake Host and reusable conformance suite. Production
sources cannot import it; a boundary test enforces this rule. Crypto is
injected into the fake, and the tests verify real Ed25519 proofs.

## Host grants

`libs/shared/src/host-grant.ts` defines
`phosphor-grant.v1.<payload>.<signature>`, with canonical unpadded base64url
parts. This is not a JWT: the algorithm is always Ed25519, with no header.
Parsing is not signature verification. Signing and verification belong to
the apps, not the shared contract.

A grant names a control origin, key id, owner, login session, Host, enrollment
epoch, client id and label, capabilities, issue and expiry times and a unique
id. It carries no lane contents, repository names or paths. The Host verifies
the signature against a bounded control keyset and checks issuer, Host, owner,
epoch, a lifetime of at most 300 seconds, clock skew and revoked sessions or
clients. A renewal cannot change the owner or client identity. Effective
capabilities are the intersection of grant and Host capabilities. Seeing an
enrolled machine is never a grant to execute on it.

## Tracing a machine

All three sides timestamp each line in ISO 8601 UTC with milliseconds.

- Desktop: `~/Library/Logs/Phosphor/phosphor.log` on macOS,
  `~/.config/Phosphor/logs/phosphor.log` on Linux. Main writes `[account]`,
  `[control]`, `[machines]` and `[hosts]` lines. Test profiles use their own log folder.
- Host: `${XDG_STATE_HOME:-~/.local/state}/phosphor-host/logs/phosphor.log`.
  The owner-only file rotates at 5 MB. `login`, `status`, `logout`, `run` and
  service commands write there without changing terminal output.
- Server: JSON lines on stdout. Read them with
  `kubectl -n phosphor logs deploy/phosphor-site | grep -v '"route":"site"'`.
  Only `/healthz` (the Kubernetes probes) is left out of the log.

Each control call records `method`, the route template (never the query),
`status`, `ms`, `requestId` and `trace`. Client failures add `code`; server
failures add `error`. Transport failures have status 0 and no request id.
The server returns `x-request-id`; clients record only its validated hex value.
The logging-only headers `x-phosphor-client` and `x-phosphor-trace` identify the
client kind/version and a 16-character lowercase hex operation id. A Host
command or Desktop refresh gets a new trace. Lookup and approval share a trace.
The pending lookup trace expires with the enrollment, capped at 15 minutes.
A failed lookup, sign-out or account change clears it; approval consumes it.
Two Add-a-machine attempts in separate windows at the same time may share or
swap trace ids. Join lookup to approval by `keyFingerprint`, which each response
supplies; the trace is a convenience, not the authoritative join.
Desktop sign-in has its own account trace. A malformed client header records
`client: "invalid"` and a missing one `null`; a missing or malformed trace is
`null`. Neither changes authorization or limits.

For example, enrolling bee1 produces this order:

1. Desktop calls `/me`, then `/machines` with one refresh trace.
2. Host calls `POST /enrollments`. `enrollment.created` links the enrollment id
   to the key fingerprint, hostname, OS, architecture and Host version.
3. Host polls every five seconds with its login trace. `enrollment.poll` records
   the enrollment id and pending result.
4. Desktop looks up the code, then approves. `enrollment.lookup` records the
   fingerprint and user id. `enrollment.approved` links the same fingerprint to
   the Host id, user id and label. Fingerprint joins these events to creation;
   the enrollment id joins creation to polling. No code appears in a log.
5. Host polls and learns its approved Host id.
6. Host saves `identity/host.json`, then calls `GET /hosts/self` for its self
   check. The identity is saved before this check, so a failed check still leaves
   a saved identity that `phosphor status` can inspect.
7. Once `phosphor run` starts, each heartbeat has an access line and a client
   call line with its sequence. The first accepted beat this server process
   sees, or one after more than 90 seconds of silence, emits `host.connected`.
   A running/stopping or readiness change emits `host.state` once per observed
   transition. Removal emits `host.removed`; a beat naming a removed Host emits
   `host.refused` with reason `gone`. That check runs before the signature, so
   the host id in `host.refused` is claimed, not proven. A failed poll's
   `enrollment.poll` likewise carries the claimed enrollment id and the
   failure code as its result.

Server heartbeat observation is process-local, capped at 10,000 Hosts with the
least recently beaten evicted. Restarting the server emits `host.connected`
again on each Host's next accepted beat. Refused beats do not update this history.
Desktop logs initial machine states and transitions only when `/machines` is
fetched, correcting its clock with `serverTime`. A silent machine's offline
observation appears at the next fetch, not on a separate logging timer. A
missing machine is observed as removed once. This history is capped at 1,000
Hosts and cleared on sign-out or account change. Server heartbeat events and
`lastSeenAt` are the liveness record; Desktop lines show what a fetch observed.
Realtime join, leave, error and fallback polling start/stop lines explain why a
refresh may follow.

Logs never include user codes, access or refresh tokens, cookies, auth headers,
private or public keys, signatures, nonces, edge secrets, peer/client addresses or raw
request/response bodies. A public key appears only as its fingerprint. Errors
record a bounded code or reason class, not a peer's message or exception text.
The server never logs source/socket addresses or `cf-connecting-ip`. Clients
never log resolved addresses or local interface addresses. The Host logs only
the configured control origin, including a numeric origin when configured,
never userinfo, paths or queries.

## Trust boundary

The control plane holds identity and machine metadata only. Host public keys
are the only machine keys it stores. It never stores lanes, prompts,
transcripts, paths, repository names, artifacts or provider credentials.
Aggregate lane counts are machine metadata, not lane records. Host private keys
stay on their machine; Desktop sign-in credentials stay in its main-process
vault, outside the directory. Directory visibility and enrollment are not
execution authority. Local Desktop works without sign-in.

Linux Desktop detects supported session keyrings before Chromium starts. Where
Chromium reports `basic_text`, the vault uses a user-only refresh-token file,
not hard-coded-key encryption; unknown or unavailable keyring backends refuse
storage. [Settings](settings.md#phosphor-account) owns these storage rules.
Future execution and sharing directions live in [future-features.md](future-features.md).

## Portable session service

`libs/session-runtime/src/pi/` contains the Electron-free session service: launch/policy preparation,
startup/readiness, event binding, command/provider/budget admission, resume reuse,
per-owner path locks and stop-before-delete coordination. Desktop binds its existing
preferences, accounts, package discovery, Headroom, recents, window delivery and
Trash behavior in `apps/desktop/electron/pi/session-runtime.ts` and `delete-lane.ts`.

`session-service-headless.test.ts` bundles a plain Node entry and runs it against
a deterministic fake pi subprocess. It checks streaming, resume reuse, provider
and routine guards, interrupt bypass, crash resume, deletion and shutdown
admission. `boundary.test.ts` rejects Electron/Desktop imports from every runtime
entry. Neither test is real-provider or remote-host acceptance.

The locks are process-local. The Host's entry point is the `phosphor` CLI
([host.md](host.md)), a foreground CLI that checks a machine and runs
acceptance sessions on it. It composes the session runtime with its own
adapters. Its control commands make outbound requests. `run` also opens a
loopback API after learning its owner and epoch from a heartbeat. The API
authenticates grants. Its adapter routes lane frames only when composition supplies
a lane service with the same process epoch. A Host supplies its own machine
adapters and authorization: it
builds pi's environment from its own config and never accepts spawn
environment or executable inputs from a caller. No local daemon or login is
required.

## Control-directory schema

`supabase/migrations/` holds versioned PostgreSQL migrations for five tables:

- `remote_access_accounts`: server-managed suspension state, GitHub login and
  update time. New accounts are enabled by default.
- `remote_hosts`: owner, label, hostname, public key, fingerprint, platform,
  architecture, version, heartbeat sequence and state, readiness, lane counts,
  optional bare HTTPS endpoint and revocation epoch.
- `remote_clients`: owner, client kind, display label and revocation metadata.
- `remote_enrollments`: hashed user codes, public keys and machine metadata.
  Pending codes expire after ten minutes. Approval links the owner and Host
  atomically and leaves at least two minutes to collect the approved result.
- `remote_audit_events`: owner, Host, event kind and time for enrollment,
  rename, owner revocation and self-revocation. No labels or IPs are recorded.

All tables have row-level security. Authenticated users can read their own
account state. Enabled owners can read their host, client and audit rows,
including revoked entries. Anonymous roles have no table access. Enrollment
rows have no client grants or RLS policies. Clients cannot write any table.

Only the server writes. The `service_role` can execute the public `control_*`
functions for account refresh, enrollment create/poll/lookup/approve, machine
list/rename/revoke and Host key/self/self-revoke/heartbeat. These functions are
security invokers with an empty search path. Both client roles and `public`
lose execute privileges, including on the timestamp and MachineView helpers
in the non-exposed `control_private` schema. The server separately authenticates
requests and checks account suspension. RLS is not its authorization boundary.

Approval locks the enrollment and account, enforces twenty active Hosts per
owner and relies on a partial unique index to prevent active public-key reuse.
Keys use canonical base64url so each key has one spelling. Labels reject control
and bidi characters. Endpoint ports, when present, are between 1 and 65535.
Creation serializes pending admission, caps it at three per key and ten thousand
in total, and removes at most a thousand old enrollments and old audit events
per call. Audit cleanup targets events older than 180 days. Heartbeats atomically
require an increasing sequence and ten seconds between beats, except stopping beats.
Revocation increments the epoch. Machine lists exclude revoked Hosts. Timestamp
and MachineView JSON helpers keep responses consistent with the shared contract.

`remote_hosts` is in the `supabase_realtime` publication. Realtime is a change
signal for refetching, not an execution or mutation API. Directory visibility
is not an execution grant. Endpoint storage validation is not network authorization.

There are no prompts, filesystem paths, transcripts, artifacts, private keys or
provider credentials in these tables. Public keys identify Hosts only. Lane
counts do not contain lane data. Account deletion cascades through its directory
records only, not remote files. Applying a migration does not install an agent,
enable signup, or expose any execution service.

## Local validation

Docker is required. The pinned Supabase CLI uses project ID
`phosphor-control-test`, API port 54351 and database port 54352. It does not link
to a hosted project and must not reuse another application's stack.

```bash
npm run db:start
npm run test:control-db
npm run test:auth-stack
CONTROL_DB=1 npm run validate
npm run db:stop
```

`db:stop` removes this disposable test stack and its data. Never put real
sessions or credentials in it. Other Supabase stacks are not stopped.
Only GitHub can sign up, and GitHub here is a local fixture
(`supabase/tests/fixtures/fake-github.cjs`); email sign-up is off. The pgTAP
tests insert synthetic users inside a transaction and roll back. One file,
`control_grants_race.test.sql`, needs two real connections to race grant
issuance, so it commits one synthetic owner through `dblink` with the local
stack's default password and deletes it before, after and on any error. The pgTAP suite
exercises real Supabase roles and `auth.uid()`, including anonymous access,
ownership isolation, disabled accounts, forbidden client writes and server-role
access. CI starts/tests/stops its own stack and never receives hosted database
credentials. Local CLI output includes test keys; do not publish it as
production setup information.

`npm run test:auth-stack` (`tools/scripts/auth-stack.mjs`) runs Desktop's
sign-in code (`apps/desktop/electron/account/`) against this stack's real
Supabase Auth. It starts the fake GitHub in a container on the stack's network,
and removes only that container, also when the test hangs (it runs in its own
process group, killed after 3 minutes) or the run is cancelled. The test signs
in through PKCE and the loopback callback, refreshes (checking the new token was
saved), restarts from the saved token, and signs out, then checks that Supabase
revoked the session. It also covers a denial in the browser, a wrong verifier
and a reused code. The runner fails if any test was skipped. CI runs it in the
Control job, and `CONTROL_DB=1 npm run validate` runs it after
`test:control-db`.

## Opt-in transport probe

`tools/scripts/run-remote-probe.mjs` is a disposable diagnostic server, not a host daemon.
It binds only `127.0.0.1`, requires one exact HTTPS Origin and a random 32-byte
hex token, and stops after five minutes, terminating existing streams. It exposes
only `/probe`: authenticated GET and WebSocket diagnostic messages. No pi,
commands, files, cookies or durable state are accessible. Unit tests exercise
preflights, rejected origins/tokens, streaming, reconnect and expiry.

With Node and this repo's development dependencies installed, supply `PROBE_TOKEN`
through a protected environment, not command arguments or a URL, then run:

```bash
PROBE_ORIGIN=https://phosphor.saccolabs.com PROBE_PORT=18591 node tools/scripts/run-remote-probe.mjs
```

For a real host, inspect `tailscale serve status --json` first. Only on an unused
port, run foreground `tailscale serve --https=8443 http://127.0.0.1:18591` (sudo
may be required). Never use Funnel or overwrite another route. Wait for certificate
issuance; do not disable TLS verification. Stop the foreground Serve command and
remove the probe files after testing. Tailscale owns its certificate cache.

The browser runner uses a fresh, isolated Playwright profile. Set `PROBE_CONFIG`
to a mode-0600 JSON file containing `pageUrl`, `endpoint` and `token`; use the
public page URL and the host's HTTPS `/probe` endpoint. Never commit this file.
Run `node tools/scripts/probe-browser.mjs` after installing the desired Playwright
browser. `PROBE_BROWSER` selects `chromium` (default), `webkit` or `firefox`.
It tests real cross-origin fetch, token rejection, streaming and reconnect.

Chromium requires local-network permission. Test the default refusal first;
`PROBE_LOCAL_NETWORK_CONSENT=1` explicitly grants that permission in the test
profile, without disabling browser security. This does not test an onboarding
permission prompt. Automated WebKit is not real Safari or an iPhone. Real mobile
Safari/Chrome, suspension, network switching and installed-PWA tests are still
required before choosing the public-origin PWA approach. Neither this probe nor
its browser runner is loaded by Electron or deployed with the public website.

## Hosted directory

The provisioned `phosphor` project is `bzdbiswndlqvviiywsvj` in `us-west-1`.
Its directory tables have RLS enabled, no anonymous access and no direct client
mutation privileges. Provisioning the schema does not enroll users, hosts or clients.
Brigades is a separate product and is never a deployment target.

The checked-in migration version matches Supabase's migration ledger. MCP
assigns its own timestamp during application, so the initial migration filename
uses that returned version without changing its SQL. Later deployments must
reconcile the ledger before applying anything; do not replay an existing schema
under a second version. Hosted changes require explicit target verification.
Local test success does not imply deployment.

## Install a Host over SSH

Machines > Add a machine > Install over SSH uses the system `ssh` in Desktop
main, only for installation and repair. Enter `user@host` or an SSH config alias.
Desktop uses your agent, keys and known_hosts. It never requests a password or
accepts an unknown host key. Agent and X11 forwarding and configured tunnels are
disabled. If connection fails, run the displayed `ssh TARGET`
command once in a terminal, then try again.

Optionally enter a repository relative to the remote home, such as `src/project`.
It must already exist. Only letters, digits, dots, underscores, hyphens and path
separators are allowed, with no `.` or `..` segments or leading hyphens. Without
it, setup uses the existing config or the remote working directory's git root.
If neither exists, choose a repository and retry. pi and the installer prerequisites
must already be installed on the machine ([host.md](host.md#setup)).

Desktop pipes its bundled signed-manifest installer to `sh -s --`, using the
installer's latest-release default, then runs non-interactive setup, login and
user service installation as separate SSH processes. Login stays running while
you approve the code in the same dialog as manual enrollment. Desktop looks up
the code from login stdout only and refuses a fingerprint mismatch. Banners and
stderr cannot supply the enrollment. Desktop discards login stdout through a fresh
per-job sentinel and fails the step if that sentinel is missing. Both fingerprints
appear inline.
The Host saves its own identity after approval. The dialog waits for service
installation to finish before offering Close or View machine. Cancel remains
available while waiting, and SSH failures stay visible. SSH is never the lane
transport.

One install runs per target, with at most eight jobs. Install steps time out after
ten minutes; login ends when its code expires, with a ten-minute upper bound.
Cancel or closing the dialog kills the local SSH process group. It does not roll
back a completed remote step or revoke an approved machine. Retry is explicit.
Failures show fixed guidance and a collapsible, bounded last 20 lines of remote
output. Output, targets, codes and fingerprints stay out of Desktop logs.

### Terminal capability

Hosts with their target's native node-pty resources announce `terminal` after the
fixed-relative loader succeeds. The Host serves lane-scoped terminal list,
fenced create/resize/kill commands, sequenced controller-only input, and bounded
output subscriptions. Viewers may watch but cannot type. Revoking the terminal
capability detaches subscriptions and refuses input. No terminal input or output
is sent to control or persisted on Desktop. Native resources are built per OS and
architecture with pinned Node and included in the signed release archive.
Desktop remote terminal UI routing is not implemented yet. The protocol and Host
limits are documented in [Host terminals](host.md#host-terminals).
