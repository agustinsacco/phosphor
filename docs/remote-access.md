# Remote-access foundation

Remote execution is not enabled. Local Electron still needs no Phosphor login.
The shared host handshake and control-directory schema are foundations, not a
running control plane or an exposed host API.

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
adapters, and nothing reaches it over a network.
There is no durable Host ownership, authenticated network API,
snapshot/replay protocol, command receipt store or controller lease
implementation. A Host supplies its own machine adapters and authorization: it
builds pi's environment from its own config and never accepts spawn
environment or executable inputs from a caller. No local daemon or login is
required.

## Control-directory schema

`supabase/migrations/` holds versioned PostgreSQL migrations for three tables:

- `remote_access_accounts`: server-managed eligibility for remote access.
- `remote_hosts`: owner, display label, endpoint and revocation metadata.
- `remote_clients`: owner, client kind, display label and revocation metadata.

All tables have row-level security. Authenticated users can read only their own
eligibility. Eligible owners can read their host/client rows, including revoked
entries for access-management views. They cannot enroll, modify, reassign or
remove records directly. Anonymous roles have no table access. The server role
can mutate rows and bypasses RLS; a future server endpoint must separately
authorize every operation and check revocation. Directory visibility is not an
execution grant. Endpoint storage validation is not network authorization.

There are no prompts, filesystem paths, transcripts, artifacts or provider
credentials in these tables. Account deletion cascades through its directory
records only, not remote files. Applying a migration does not install an agent,
enable signup, or expose any execution service.

## Local validation

Docker is required. The pinned Supabase CLI uses project ID
`phosphor-control-test`, API port 54351 and database port 54352. It does not link
to a hosted project and must not reuse another application's stack.

```bash
npm run db:start
npm run test:control-db
CONTROL_DB=1 npm run validate
npm run db:stop
```

`db:stop` removes this disposable test stack and its data. Never put real
sessions or credentials in it. Other Supabase stacks are not stopped.
Local signup is disabled; tests insert synthetic users inside a transaction
and roll back. The pgTAP suite exercises real Supabase roles and `auth.uid()`,
including anonymous access, ownership isolation, disabled accounts, forbidden
client writes and server-role access. CI starts/tests/stops its own stack and
never receives hosted database credentials. Local CLI output includes test
keys; do not publish it as production setup information.

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
