# Control plane

`apps/control` is a plain Node 22 server. It serves the built Astro site and the
shared JSON contract in `libs/shared/src/control-api.ts`. It stores identity
and machine metadata only. It does not handle prompts, transcripts, files,
repository names or provider credentials. It brokers grants; lane execution and
content travel directly between Desktop and Host.
Hosts enroll through a code approved by a signed-in user, then report readiness
and machine state through signed heartbeats.

## Routes and boundaries

- `GET /healthz`: process liveness, independent of Supabase.
- `GET /api/v1/health`: `{ok, version, configured}`.
- `GET /api/v1/me`: authenticated account handle, enabled flag and host limit.
  It calls `control_account` to upsert the account and refresh its GitHub login.
  Suspended accounts can still read this route.
- `POST /api/v1/enrollments`: key-signed enrollment creation. The signed key must
  match the body key. Codes expire after ten minutes and only their SHA-256
  hashes are stored. Code collisions retry at most three times.
- `POST /api/v1/enrollments/poll`: key-signed pending, approved or expired status.
  Approved answers remain available until expiry.
- `POST /api/v1/enrollments/lookup` and `/approve`: user-authenticated code lookup
  and approval. Lookup shows hostname, platform, architecture, Host version and
  fingerprint. Approval normalizes the label and returns the new machine.
- `GET /api/v1/machines`: user-owned active machines and the server clock.
- `PATCH /api/v1/machines/:id`: user-owned rename, returning `{machine}`.
- `DELETE /api/v1/machines/:id`: user-owned removal, returning 204 with no body.
  Unknown, revoked and other owners' machines all return 404.
- `GET /api/v1/hosts/self`: Host-signed identity and owner. Its signed body is empty.
- `POST /api/v1/hosts/self/heartbeat`: Host-signed state and readiness. Repeated
  sequence numbers return 409; beats less than ten seconds apart return 429,
  except a stopping beat. Accepted beats return the thirty-second interval and
  enrollment epoch, owner id and recent revoked session and client ids.
- `POST /api/v1/hosts/self/revoke`: Host-signed removal, body exactly `{}`,
  returning 204 with no body. Revoked and unknown Hosts return 410.
- `POST /api/v1/clients`: user-authenticated `{label}` registers a Desktop install
  and returns `{client: {id, label}}`. At most twenty active clients per owner.
  Registration is limited to ten per hour per user.
- `DELETE /api/v1/clients/:id`: owner-only client revocation, 204 with no body.
  Unknown, already revoked and other owners' clients return 404.
- `POST /api/v1/grants`: user-authenticated `{hostId, clientId}` returns
  `{grant, expiresAt, host: {id, endpoint, publicKey}}`. Both identities must be
  active and owned by the caller. The verified access token must carry a UUID
  `session_id`. Issuance is limited to 120 per minute per user.
- `GET /api/v1/grant-keys`: public `{keys: [{kid, publicKey}]}`. Raw Ed25519 public
  keys are base64url. This route alone uses `public, max-age=300` caching.

Every user route except `/me` checks account suspension and refuses it with 403.
Key conflicts and the per-account active Host limit return 409. All request and
response fields pass through the shared contract's parsers; unknown fields are
not returned or stored.

Every API response is JSON with `no-store` (except the public grant keyset), `nosniff`, `no-referrer`, a CSP that
allows no content or framing, and a generated `x-request-id`. Errors use the
contract's `ControlErrorBody`. Unknown API routes return 404; incorrect methods
on registered API routes and OPTIONS return 405. There are no CORS headers.
Raw request targets are checked before URL normalization. Dot segments, empty
segments, backslashes, encoded separators and null bytes are refused. Unsafe API
targets return 400; unsafe site targets return the site's 404.
GET, HEAD and DELETE refuse Transfer-Encoding or a Content-Length other than 0
before body reading. Their signed body is empty. POST, PATCH and PUT bodies are
capped at 16 KB by counting streamed bytes, not by trusting
Content-Length. Bodies require `application/json` and valid JSON. If the server
has no secret key, health returns `configured: false` and all other API routes
return 503. Static pages remain available.

Site GET and HEAD use `$uri`, then `$uri/index.html`. Misses return status 404,
using the site's `404.html` when present or an empty body otherwise. The current
Astro build has no 404 page. There are no directory listings. Encoded separators,
null bytes, dotfiles and symlinks outside the site root are refused. The site
root is a trusted, immutable build directory, not an upload directory. Assets
under `/_astro/` and `/fonts/` are cached for a year as immutable. Text types
above 1 KB support gzip. Other pages use `nosniff` and
`strict-origin-when-cross-origin`. The old Claude guide redirects to
`/guides/accounts/` with a relative Location.

## Authentication ports

User requests carry a Supabase access token as Bearer. Before calling Auth, the
server checks the token's three base64url parts, 4096-character limit, future
`exp`, and `authenticated` audience. It then calls `/auth/v1/user` with the
publishable apikey and user bearer. Auth 401/403 means unauthenticated. Other
failures and five-second timeouts mean unavailable. Successful identities are
cached by token SHA-256 for at most 30 seconds, never past expiry, with a
1000-entry cap. Account suspension is checked through RPC on every request,
not cached. Each cache-miss Auth verification consumes a per-IP limit of 30 per
60 seconds before contacting Supabase. Cache hits and cheap pre-check failures
are free. The exported user guard refuses suspended accounts on other routes.

The exported Host guard supports a raw Ed25519 public key or an enrolled UUID,
never both. It verifies the shared signing string against the exact body bytes,
requires timestamps within 60 seconds, rejects queries or any rewritten raw
path. It consumes a nonce only after verification. Nonces live for 120 seconds in two separate
100,000-entry caches: one for enrollment keys and one for enrolled Hosts. Expired
entries are swept. A full cache refuses new nonces with 429 without evicting live
replay records. Enrollment traffic cannot fill the enrolled Hosts' cache.
Enrolled key lookup consumes a per-IP limit of 120 per 60 seconds before any RPC.
Key-mode verification needs no upstream lookup or auth limiter.
Enrolled key lookup is an injected port; gone
and unknown Hosts both produce 410.
The shared signing vector is tested against the verifier.

Supabase RPC uses the secret apikey only, not a bearer: `sb_secret_` keys are not
JWTs. Fetches have five-second deadlines and a 64 KB response cap. RPC output
is validated before reaching the wire. Each access line includes `ts`, `level`,
`requestId`, `method`, route pattern, `status`, `ms`, `actor`, `client`, `trace`
and `error` (null on success). Malformed logging-only client or trace headers
record `client: "invalid"`; no client header records `client: null`, and an
invalid trace is null. The two are judged separately. Static requests use
`route: "site"` and `pathClass: "page"` or `"asset"`, never a concrete path.
Only `/healthz`, the probes' path, does not log. Nothing a caller sends, such
as its user agent, can keep a request or an event out of the log.

Domain lines add `event`, the request id, trace and timestamp. Creation and
polling link by enrollment id; lookup and approval link by fingerprint. Accepted
beats emit connection and state transitions once per process observation;
removal and refused removed-Host beats have their own events; a refused beat's
host id and a failed poll's enrollment id are claimed, not verified. The bounded
10,000-Host observation history evicts the least recently beaten Host and resets
on process restart. Nothing logs headers, bodies, tokens, codes, keys, peer/client IPs,
edge secrets or peer error messages. [Tracing a machine](remote-development.md#tracing-a-machine)
lists the events and their correlation rules.

Rate limits are sliding windows held per purpose, the key prefix before the
first colon. Each of the eight purposes (`enrollment-create`, `enrollment-poll-ip`,
`enrollment-poll`, `enrollment-failure`, `user-verify`, `host-auth`,
`grant-issue`, `client-register`) has its own 10,000-key cap, 80,000 keys in all.
At capacity a purpose sweeps its expired windows and refuses new keys with 429
rather than evicting live windows. Saturating one purpose never refuses another,
so an unauthenticated enrollment flood cannot spend the capacity of user
verification, Host authentication or grant issuance. A key of an undeclared
purpose is refused. Enrollment creates are limited to ten per hour per IP before signature checking
or nonce consumption. Polls are limited to sixty per minute per IP before the
request contract is validated, then to one per two seconds per parsed enrollment id, both
before signature checking; Hosts sharing an address share the first limit.
Failed lookups and approvals share ten failures per fifteen minutes per user.
Guesses still awaiting the database count against that budget, so concurrent
requests cannot exceed it. Successes do not spend it. Once exhausted, both
routes return 429, even for a correct code, until a failure leaves the window.
Proxy IP selection trusts a valid `cf-connecting-ip` only in Cloudflare mode
when `x-phosphor-edge` matches `CONTROL_EDGE_SECRET`. SHA-256 digests are compared
in constant time. Missing or incorrect edge headers use the socket address.
servicelb SNAT hides peers, so all non-Cloudflare LAN and tailnet clients share
that address bucket. Headers and comparison results are never logged. All in-memory guards are
process-local. Run a single replica; rollout overlap is not cross-process replay
protection.

## Grants and revocation

Grants use `phosphor-grant.v1.<base64url(payload JSON)>.<base64url(signature)>`.
Ed25519 signs the exact payload bytes, without a header or algorithm choice.
Claims are `v`, `iss`, `kid`, `sub`, `sid`, `hostId`, `epoch`, `client: {id, label}`,
`caps`, `iat`, `exp` and `jti`. Issuance includes all `HOST_CAPABILITIES` and sets
`exp = iat + 300` seconds. Hosts still gate features by what they implement.
The broker never receives lane ids, prompts or repository names. Issuance logs
only `userId`, `hostId`, `clientId`, `jti` and `exp`. Client registration and
revocation events carry only user and client ids. Session ids, grants, tokens,
signatures and keys are never logged.

`CONTROL_GRANT_KEYS` holds at most eight comma-separated `kid=seed` entries,
with unique 1-64 character ids (letters, digits, `_` or `-`) and canonical
base64url 32-byte Ed25519 seeds. The first entry signs; every entry publishes its
public key. Invalid configuration fails startup without echoing any value.
Unset keys make grant issuance and the public keyset return 503; enrollment,
clients and machine routes still work. `tools/scripts/grant-key.mjs` prints one
fresh entry to stdout only. Pipe it directly into the operator's secret store,
not a file or log.

To rotate, first append the new key while the old key still signs, then move the
new key to the first position. Keep the old key published until existing grants
and cached keysets have expired. The keyset response may be cached for five
minutes; a Host that meets an unknown key id fetches the keyset again.
`CONTROL_PUBLIC_ORIGIN` is the exact bare issuer origin, HTTPS or HTTP on
`localhost` or `127.0.0.1` with a port for local stacks. Paths, queries,
fragments and userinfo are refused. Hosts compare it to their configured
control origin.

Accepted heartbeats query the active Host's owner and epoch and return
`revoked: {sessions, clients}`. Each list holds at most 100 ids, newest first:
clients revoked in the last ten minutes, and tracked sessions issued in the
last ten minutes whose Auth session no longer exists. Admission keeps every
owner inside those lists, so a list never drops a revocation that still matters:
registration refuses a client (429) once the owner has 100 clients that are live
or were revoked in the last ten minutes, and issuance refuses a grant (429) for a
new session once the owner has 100 sessions issued in the last ten minutes. A
session already tracked always renews. Issuance takes the owner's account row
lock first, so concurrent issues cannot both pass the cap. Cleanup of sessions
older than ten minutes rechecks the age on each row it deletes, so a session
refreshed by a concurrent issue is kept. The session table has RLS
and no client policies or grants. Only the server may call the RPCs. The
revocations RPC is a fixed-search-path security definer because Supabase's
service role cannot read `auth.sessions`; it reads only session ids. Other
RPCs remain security invokers. Client revocation or sign-out reaches open Host
streams on the next successful heartbeat, normally within thirty seconds.
If the revocation query fails after an accepted beat, the beat still succeeds
but omits all three new fields and logs `heartbeat.revocations_unavailable`
with only the Host id and an error code. Hosts treat missing fields as no news,
not as clearing earlier revocations. The grant's five-minute lifetime bounds
access during an outage; the ten-minute window covers a later successful beat.

## Configuration and local use

| Variable                   | Default                          | Constraint                                                                              |
| -------------------------- | -------------------------------- | --------------------------------------------------------------------------------------- |
| `PORT`                     | `5015`                           | 0 through 65535; 0 selects a test port                                                  |
| `SITE_DIR`                 | `/app/site`                      | Trusted built site directory                                                            |
| `SUPABASE_URL`             | Hosted Phosphor origin           | HTTPS, or HTTP on localhost, 127.0.0.1 or [::1] only                                    |
| `SUPABASE_PUBLISHABLE_KEY` | Hosted publishable key           | Public Auth apikey                                                                      |
| `SUPABASE_SECRET_KEY`      | Unset                            | Secret RPC apikey; never put it in a URL or command argument                            |
| `CONTROL_GRANT_KEYS`       | Unset                            | At most eight `kid=seed` entries, at most 4096 characters; first entry signs            |
| `CONTROL_PUBLIC_ORIGIN`    | `https://phosphor.saccolabs.com` | Exact bare HTTPS origin, or HTTP on localhost or 127.0.0.1 with a port for local stacks |
| `CONTROL_TRUST_PROXY`      | `none`                           | `none` or `cloudflare`                                                                  |
| `CONTROL_EDGE_SECRET`      | Unset                            | Required in Cloudflare mode: 32-512 letters, digits, `_` or `-`; ignored with `none`    |

```bash
npm run site:build
npm run build:control
SITE_DIR=apps/site/dist node apps/control/dist/server.mjs
```

For local Supabase, use only the isolated `phosphor-control-test` stack described
in [local validation](remote-development.md#local-validation). A protected environment
must supply its publishable and secret keys and
`SUPABASE_URL=http://127.0.0.1:54351`. Do not print or commit `supabase status -o env`
values. The routes need the control enrollment migration on that stack.
`npm run test:control-stack` runs the API with real local RPC and Auth ports,
fake GitHub sign-in for two owners, signed Host requests and session revocation.
It removes its test enrollments and users and leaves the stack running. Run it
and `npm run test:auth-stack` sequentially; they share the fake GitHub container.

The esbuild output is `apps/control/dist/server.mjs`, with no runtime
node_modules. Builds reject non-`node:` imports. SIGTERM and SIGINT stop accepting
requests and finish in-flight work; shutdown is forced within ten seconds.

## Image and deployment

`apps/control/Dockerfile` builds from the repository root. Its dedicated ignore
file excludes unrelated apps, build output, dependencies and secret-shaped files.
The Astro builder installs DejaVu fonts, runs its own `npm ci`, check and build.
The Control builder installs its own dependencies and bundles `server.mjs`.
The Node 22 Alpine runtime contains only that bundle and `/app/site`, runs as
uid/gid 1000 and needs no writable volumes. `bash tools/scripts/site-image.sh`
builds and checks the image read-only with all capabilities dropped, then runs
the site browser suite and removes its container. CI uses the same script.

The `phosphor-site` Deployment and LoadBalancer Service keep port 5015 and a
single replica. Probes use `/healthz`, independent of Supabase. The pod has a
read-only root, no privilege escalation, RuntimeDefault seccomp, a 256Mi memory
limit and fifteen seconds for the server's ten-second shutdown.

Deploy Site builds this Dockerfile and pins the pushed image digest. The
`phosphor-control` Secret supplies required `supabase-secret-key`, `edge-secret`
and `grant-keys` keys. No reference is optional: missing configuration fails the
rollout. The template holds only `${SUPABASE_SECRET_KEY}`, `${CONTROL_EDGE_SECRET}`
and `${CONTROL_GRANT_KEYS}`. The workflow validates the first two repository
secrets against `^[A-Za-z0-9_-]{32,512}$` and the grant keys' shape (1 to 4096
letters, digits, `_`, `-`, `=` or `,`; the server parses them strictly at
startup), then uses restricted `envsubst` to render only those placeholders into a 0600
file under `RUNNER_TEMP`. Unresolved placeholders fail. The Secret is applied on
its own with kubectl's output suppressed, because diagnostics can carry its data
in a form log masking misses; it is not part of the kustomization. Cleanup runs
even on failure; values are never printed. Each deploy stamps the pod template
with its run id, so the pods restart and read a rotated Secret even when the
image is unchanged. Production sets `CONTROL_TRUST_PROXY=cloudflare`.
The Cloudflare Transform Rule must overwrite `x-phosphor-edge` with the same
edge secret. No source-range filtering is used because servicelb SNAT hides
LAN and tailnet peers as well as the tunnel connector.

After rollout the workflow requires a Service address, then checks the public
site title, `/healthz` and `/api/v1/health` with `configured: true`. It retries
for at most two minutes and fails if any check stays unavailable.

## Control-directory schema

`supabase/migrations/` holds versioned PostgreSQL migrations for six tables:

- `remote_access_accounts`: server-managed suspension state, GitHub login and
  update time. New accounts are enabled by default.
- `remote_hosts`: owner, label, hostname, public key, fingerprint, platform,
  architecture, version, heartbeat sequence and state, readiness, lane counts,
  optional bare HTTPS endpoint and revocation epoch.
- `remote_clients`: owner, client kind, display label and revocation metadata.
- `remote_grant_sessions`: recently issued Auth session ids and times for bounded
  heartbeat revocation checks. It has no client grants or policies.
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
list/rename/revoke and Host key/self/self-revoke/heartbeat, client registration and
revocation, grant issuance and revocation lookup. These functions use an empty
search path. They are security invokers except the revocation lookup described in
[Grants and revocation](#grants-and-revocation). Both client roles and `public`
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

Hosted migration work requires explicit target verification and reconciliation
with the migration ledger. Never replay an existing schema under a second
migration version or target another product's database. Local test success does
not prove deployment. Only the disposable `phosphor-control-test` stack belongs
to automated local validation.
