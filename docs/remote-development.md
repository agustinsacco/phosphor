# Remote development and diagnostics

Use disposable profiles and repositories. Never test against user sessions or a
hosted database. [Remote access](remote-access.md) is the product entry point.

## Tracing a machine

All three sides timestamp each line in ISO 8601 UTC with milliseconds.

- Desktop: `~/Library/Logs/Phosphor/phosphor.log` on macOS,
  `~/.config/Phosphor/logs/phosphor.log` on Linux. Main writes `[account]`,
  `[control]`, `[machines]` and `[hosts]` lines. Test profiles use their own log folder.
- Host: `${XDG_STATE_HOME:-~/.local/state}/phosphor-host/logs/phosphor.log`.
  The owner-only file rotates at 5 MB. `login`, `status`, `logout`, `run` and
  service commands write there without changing terminal output.
  [Spawn argv](pi-integration.md#process-model) records `--append-system-prompt` with
  its value replaced by `[redacted]`, not the machine/directive text.
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

The Host API accepts `x-phosphor-trace` on `/v1/hello`. Desktop main generates a
new trace per WebSocket connection and sends it in the optional `auth.trace`
field, including renewals. Both use exactly 16 lowercase hex characters. Invalid
hello headers are omitted from logs; invalid auth traces reject the frame. The
Host records the connection trace on `api.connected`, `api.command`,
`api.receipt` and `api.closed`. These events contain only safe operation, outcome,
close code and duration fields, never wire ids, paths or content. Traces do not
authorize requests.

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
environment or executable inputs from a caller. Local Desktop work requires
neither the Host daemon nor a Phosphor login.

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
permission prompt. Automated WebKit is not real Safari or an iPhone. This probe does not prove
real mobile Safari/Chrome behavior, suspension, network switching or installed-PWA
operation. Neither this probe nor
its browser runner is loaded by Electron or deployed with the public website.

## Testing remote lanes

`npm run test:e2e -- remote.spec.ts machines.spec.ts account.spec.ts` launches
isolated Desktop profiles with the pi stub. The remote spec also builds and runs
the real dev Host CLI with ordinary disposable config, identity, SQLite state
and its own fake pi. A loopback control fixture signs short-lived grants with a
throwaway key. It checks the machine-tagged sidebar lane, streamed response,
second-client takeover into viewer mode and Files content.

Only an unpackaged Desktop accepts `PHOSPHOR_E2E_HOST_ENDPOINT`, and only as
`https://127.0.0.1:<port>` with port 1024 through 65535 and no trailing slash,
path, credentials, query or fragment. Main admits that exact endpoint alongside
the unchanged production `.ts.net` rule, and uses plaintext WebSocket only for
that endpoint's `/v1/stream`. Other origins retain TLS. No Host test hook or
renderer network access is added.

The focused suites `remote-access`, `remote-chat`, `remote-files`, `remote-lanes`,
`remote-lifecycle`, `remote-pages` and `remote-switching` cover the remaining
machine-scoped flows. Pass their `.spec.ts` filenames to `npm run test:e2e --`.
`tools/scripts/site-repo-links.test.ts` checks repository links used by the site.
The site's `audit:links` command checks live external destinations after a site
build; it is separate from deterministic repository checks.
