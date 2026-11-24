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
- `DELETE /api/v1/me`: deletes the caller's account, returning 204 with no body.
  `control_account_delete` removes the Supabase user, and every directory row
  cascades with it: account state, Hosts, clients, enrollments, grant sessions and
  audit events, plus Supabase's identities and sessions. Each of its Hosts hears
  `gone` on its next heartbeat and stops. A missing account returns 404. Suspended
  accounts can still delete themselves. The anonymous usage counters are untouched.
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
  and returns `{client: {id, label}}`. There is no cap. Registration first sweeps
  the owner's browser clients that lost their session and clients revoked over a
  day ago.
- `DELETE /api/v1/clients/:id`: owner-only client revocation, 204 with no body.
  Unknown, already revoked and other owners' clients return 404.
- `POST /api/v1/grants`: user-authenticated `{hostId, clientId}` returns
  `{grant, expiresAt, host: {id, endpoint, publicKey}}`. Both identities must be
  active and owned by the caller. The grant tracks the caller's Supabase session
  id: the verified access token's UUID `session_id`, or the browser session's.
- `GET /api/v1/grant-keys`: public `{keys: [{kid, publicKey}]}`. Raw Ed25519 public
  keys are base64url. This route alone uses `public, max-age=300` caching.
- `POST /api/v1/usage/ping` and `GET /download/:artifact`: anonymous usage and
  download counters, owned by [Usage analytics](usage-analytics.md).
- `GET /api/v1/admin/stats`: the owner's aggregate summary, served only to a
  browser session on the app origin ([Usage analytics](usage-analytics.md#admin-summary)).

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
above 1 KB support gzip. MP4 and WebM videos use their media MIME types and
support single byte-range GETs for native playback and seeking (206, or 416 for
an unsatisfiable range). HEAD, multipart/malformed ranges and unvalidated
If-Range requests return the full representation; videos are not gzipped.
Stable `/media/` URLs are not cached as immutable. Other pages use `nosniff` and
`strict-origin-when-cross-origin`. The old Claude guide redirects to
`/guides/accounts/` with a relative Location.

## Authentication ports

User requests carry a Supabase access token as Bearer. Before calling Auth, the
server checks the token's three base64url parts, 4096-character limit, future
`exp`, `authenticated` audience and UUID `sub` and `session_id`. It then calls
`/auth/v1/user` with the publishable apikey and user bearer; the user it returns
must be the token's `sub`. Auth 401/403 means unauthenticated. Other
failures and five-second timeouts mean unavailable. Successful identities are
cached by token SHA-256 for at most 30 seconds, never past expiry, with a
1000-entry cap. Account suspension is checked through RPC on every request,
not cached. Only a token Auth refuses spends the address's budget of 30 per 60
seconds; once it is spent, that address's cache misses get 429 until a refusal
leaves the window. Valid tokens, cache hits and cheap pre-check failures are
free, so a signed-in user never meets it. The exported user guard refuses
suspended accounts on other routes.

The exported Host guard supports a raw Ed25519 public key or an enrolled UUID,
never both. It verifies the shared signing string against the exact body bytes,
requires timestamps within 60 seconds, rejects queries or any rewritten raw
path. It consumes a nonce only after verification. A timestamp is accepted at
both ends of its 60-second skew, so one signed request is valid for 120 seconds;
nonces live for 121 seconds, twice the skew plus a one-second margin, so a
request first accepted at the early edge is still refused at the late edge.
They live in two separate 100,000-entry caches: one for enrollment keys and one
for enrolled Hosts. Expired entries are swept. A full cache refuses new nonces
with 429 without evicting live replay records. Enrollment traffic cannot fill the enrolled Hosts' cache.
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
first colon. Each of the eleven purposes (`enrollment-create`, `enrollment-poll-ip`,
`enrollment-poll`, `enrollment-failure`, `user-verify`, `host-auth`,
`grant-issue`, `client-register`, `usage-ping`, `usage-download`, `admin-read`) has
its own 10,000-key cap, 110,000 keys in all. The two usage purposes never answer 429:
an over-limit request is answered normally and not counted.
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
Whichever address is chosen, a per-IP limit keys an IPv4 address as itself and
an IPv6 address by its /64, so every address and spelling inside one /64 shares
a bucket. An IPv4-mapped IPv6 address counts as its IPv4 address; a socket
address that is not an IP shares one `unknown` bucket.
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
last ten minutes whose Auth session no longer exists. Nothing is refused to
keep the lists that short. When one more revoked client or new session would not
fit, the server retires every grant the owner holds instead: it moves each of
the owner's Hosts to a new epoch, forgets the tracked sessions and starts both
lists again from that moment (`revocations_reset_at`). A Host closes every
stream on an epoch change and refuses older grants, so no revocation that
still matters is lost; the owner's apps reconnect with fresh grants. A session
already tracked always renews. Issuance and revocation take the owner's account
row lock first, so concurrent calls count each other. Cleanup of sessions
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
The Web builder installs the explicit shared UI/library closure independently
and builds the compact app with `PHOSPHOR_BUILD_SHA`. The Node 22 Alpine runtime
contains that bundle, `/app/site` and `/app/web`, runs as uid/gid 1000 and needs no writable volumes. `bash tools/scripts/site-image.sh`
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

Browser rollout is separately default-off. The repository variable
`PHOSPHOR_WEB_ENABLED` accepts only literal `true`/`false`; unset/empty means
`false`. It is validated in the guard before publishing/deploying, then the same
output drives the public Docker build argument and runtime overlay. Only the
Astro build receives `PUBLIC_PHOSPHOR_WEB_ENABLED`, to show **Open the app** at
`https://phosphor-app.saccolabs.com/`. No secret enters a build argument or the
browser bundle. The existing three-key `phosphor-control` Secret is unchanged.

The default `.infra/phosphor-site` kustomization selects `base/`: the same native
Deployment and Service, with **none** of `CONTROL_WEB_ORIGIN`, `WEB_DIR`, or
`CONTROL_WEB_SESSION_KEYS` present (not even empty values). When enabled, the
workflow selects `.infra/phosphor-site/web`, which adds exactly:

- `CONTROL_WEB_ORIGIN=https://phosphor-app.saccolabs.com`
- `WEB_DIR=/app/web`
- `CONTROL_WEB_SESSION_KEYS` from `phosphor-web` Secret key `session-keys`.

The separate `web/secret.yaml` template uses repository secret
`CONTROL_WEB_SESSION_KEYS`. Before publishing, and again before rollout, enabled
runs require one to eight unique `kid=base64url32bytes` entries, comma-separated,
at most 4096 characters; ids contain 1–64 letters, digits, underscores or hyphens.
Canonical encoding is checked without logging values. The Web Secret is rendered
under `RUNNER_TEMP` with mode 0600, applied separately with all kubectl diagnostics
suppressed, then removed on success/failure. Kubeconfig is private and removed
at job cleanup too. Disabled runs neither validate nor apply browser credentials.
Returning the flag to false rebuilds the link-free site and reapplies the base,
removing all Web env references without deleting the live Web Secret. Every
rollout still restarts pods for key rotation and pins the image digest.

Enabling is an operator action only after the
[external Web prerequisites](web-client.md#gated-production-rollout): reviewed
additive migration, OAuth allowlist, DNS/Host-preserving tunnel to port 5015,
edge rules for both origins without app-static `frame-ancestors`, browser-capable
Host and physical Pixel/Tailscale checks. These gates are not verified by this
repository wiring; the workflow applies no migration and starts no OAuth flow.

After rollout the workflow requires a Service address, then checks the public
site title, `/healthz` and `/api/v1/health` with `configured: true`. It retries
for at most two minutes and fails if any check stays unavailable. Enabled runs
then perform a bounded HTTPS-only anonymous app smoke: root, manifest and worker
must carry no-store and X-Frame-Options DENY, with no inherited frame-ancestors;
`/api/auth/session` must deny unsigned access (401, no-store). Marketing `/` and
`/guides/` must remain site pages with the app link. No redirect following, TLS
bypass, production HTTP fallback, cookie persistence or OAuth initiation is used.
Failure reports no upstream headers or bodies. This is not authenticated or
physical-device acceptance.

## Control-directory schema

`supabase/migrations/` holds versioned PostgreSQL migrations for eight tables:

- `remote_access_accounts`: server-managed suspension state, GitHub login,
  update time and when the owner's grants were last retired. New accounts are
  enabled by default.
- `remote_hosts`: owner, label, hostname, public key, fingerprint, platform,
  architecture, version, heartbeat sequence and state, readiness, lane counts,
  optional bare HTTPS endpoint and revocation epoch.
- `remote_clients`: owner, client kind, display label and revocation metadata.
- `remote_grant_sessions`: recently issued Auth session ids and times for bounded
  heartbeat revocation checks. It has no client grants or policies.
- `remote_web_sessions`: one row per signed-in browser: its client, owner,
  Supabase session id, the SHA-256 of its cookie handle and when it was last used.
- `remote_request_nonces`: signed Host request nonces, per identity, until
  their signature could no longer verify.
- `remote_enrollments`: hashed user codes, public keys and machine metadata.
  Pending codes expire after ten minutes. Approval links the owner and Host
  atomically and leaves at least two minutes to collect the approved result.
- `remote_audit_events`: owner, Host, event kind and time for enrollment,
  rename, owner revocation and self-revocation. No labels or IPs are recorded.

The anonymous counters `usage_daily` and `usage_downloads`, and the one-row
`control_private.admins`, belong to [Usage analytics](usage-analytics.md#schema).
None of them references a user, Host or client.

All tables have row-level security. Authenticated users can read their own
account state. Enabled owners can read their host, client and audit rows,
including revoked entries. Anonymous roles have no table access. Enrollment
rows have no client grants or RLS policies. Clients cannot write any table.

Only the server writes. The `service_role` can execute the public `control_*`
functions for account refresh, enrollment create/poll/lookup/approve, machine
list/rename/revoke and Host key/self/self-revoke/heartbeat, client registration and
revocation, grant issuance and revocation lookup, browser sessions and Host nonce
claims. These functions use an empty search path. They are security invokers
except the revocation lookup described in [Grants and revocation](#grants-and-revocation),
account deletion, the admin check described in
[Usage analytics](usage-analytics.md#admin-summary), and the two
`control_private` helpers that test and end one owner's Auth session (Supabase's
service role cannot read or delete `auth.sessions`). Each of those five runs one
fixed statement over ids the server has already verified. Both client roles and `public`
lose execute privileges, including on the timestamp and MachineView helpers
in the non-exposed `control_private` schema. The server separately authenticates
requests and checks account suspension. RLS is not its authorization boundary.

Approval locks the enrollment and account, enforces 100 active Hosts per owner
(`CONTROL_LIMITS.maxHostsPerAccount`, the most a machine list carries) and
relies on a partial unique index to prevent active public-key reuse.
Keys use canonical base64url so each key has one spelling. Labels reject control
and bidi characters. Endpoint ports, when present, are between 1 and 65535.
Creation serializes pending admission. A key keeps only its newest pending code,
so a retry is never refused; ten thousand pending codes in total is the only
cap. Creation removes at most a thousand old enrollments and old audit events
per call. Audit cleanup targets events older than 180 days. Heartbeats atomically
require an increasing sequence and ten seconds between beats, except stopping beats.
Revocation increments the epoch. Machine lists exclude revoked Hosts. Timestamp
and MachineView JSON helpers keep responses consistent with the shared contract.

`remote_hosts` is in the `supabase_realtime` publication. Realtime is a change
signal for refetching, not an execution or mutation API. Directory visibility
is not an execution grant. Endpoint storage validation is not network authorization.

There are no prompts, filesystem paths, transcripts, artifacts, private keys or
provider credentials in these tables. Public keys identify Hosts only. Lane
counts do not contain lane data. Account deletion (`DELETE /api/v1/me`) cascades
through its directory records only, not remote files. Applying a migration does not install an agent,
enable signup, or expose any execution service.

Hosted migration work requires explicit target verification and reconciliation
with the migration ledger. Never replay an existing schema under a second
migration version or target another product's database. Local test success does
not prove deployment. Only the disposable `phosphor-control-test` stack belongs
to automated local validation.

### Hosted Web schema verification

The authorized hosted target is the **personal** Supabase project
`bzdbiswndlqvviiywsvj`, name `phosphor`. Verify both identity and ownership before
any hosted work, never another product's project or org/prod AWS account
`559050243724`. The known hosted ledger maps to canonical repository SQL as
follows; a different timestamp does not mean a schema is missing:

| Canonical repository migration           | Hosted version   | Hosted name           |
| ---------------------------------------- | ---------------- | --------------------- |
| `20261005235137_remote_directory.sql`    | `20261005235137` | `remote_directory`    |
| `20261012144607_control_enrollment.sql`  | `20261012144607` | `control_enrollment`  |
| `20261013120000_control_grants.sql`      | `20261013185415` | `control_grants`      |
| `20261014120000_control_web_clients.sql` | `20261018182658` | `control_web_clients` |

The Web migration is already applied to that target from the exact checked-in
SQL. Its two functions were verified as security invokers with EXECUTE denied
to anon/authenticated and allowed to service_role. No user/credential data was
seeded. Recheck the actual state before each activation; this mapping is not a
license to run a blind `db push`, replay schemas under repository timestamps or
rewrite the hosted ledger. Do not edit applied SQL to make retries succeed.

In an authorized SQL inspection surface on the explicitly verified project, run
these **read-only** checks (no user rows or credential values):

```sql
select version, name
from supabase_migrations.schema_migrations
order by version;

select p.oid::regprocedure as function_name,
       p.prosecdef as security_definer,
       p.proconfig as function_settings,
       has_function_privilege('anon', p.oid, 'EXECUTE') as anon_execute,
       has_function_privilege('authenticated', p.oid, 'EXECUTE') as authenticated_execute,
       has_function_privilege('service_role', p.oid, 'EXECUTE') as service_role_execute,
       exists (select 1 from aclexplode(coalesce(p.proacl, acldefault('f', p.proowner))) a
               where a.grantee = 0 and a.privilege_type = 'EXECUTE') as public_execute,
       pg_get_functiondef(p.oid) as definition
from pg_proc p join pg_namespace n on n.oid = p.pronamespace
where n.nspname = 'public'
  and p.proname in ('control_web_client_status', 'control_web_clients_list')
order by p.oid::regprocedure::text;
```

Expect exactly `control_web_client_status(uuid,uuid)` and
`control_web_clients_list(uuid)`, `security_definer=false`, empty fixed
`search_path`, false anon/authenticated/public EXECUTE and true service_role
EXECUTE. Compare the definitions (allowing PostgreSQL's formatting) with
`supabase/migrations/20261014120000_control_web_clients.sql`: owner/kind/revocation
and enabled-account checks for status, bounded owner-only listing, no credential
storage. Inspect ledger statements through the authorized surface if content
reconciliation is needed; do not infer equivalence from a name alone. Stop on
missing/extra functions, unexpected privileges or content/ledger mismatch and
obtain an explicit migration/reconciliation decision. If provisioning a genuinely
new authorized target, review and apply the canonical migrations in order through
the existing approved migration process; this helper neither provisions targets
nor reconciles ledgers.

The [repeatable Web activation runbook](web-client.md#repeatable-activation) owns
the environment-only Management API helper, callback append, routing checks,
guarded flag/deploy controls and rollback. The
[local fixtures](web-client.md#repeatable-local-fixtures) reuse existing database,
Desktop-auth and Control-stack suites; they are not hosted or real PWA OAuth
acceptance. Neither an applied schema nor the OAuth allowlist enables rollout.

## Browser authentication (isolated app origin)

Browser auth is opt-in. `CONTROL_WEB_ORIGIN`, `WEB_DIR` and
`CONTROL_WEB_SESSION_KEYS` must all be set together; partial/invalid configuration
fails startup without printing values. The web origin is an exact bare HTTPS
origin with a **different hostname** from `CONTROL_PUBLIC_ORIGIN`, even if ports
differ. Production uses `https://phosphor-app.saccolabs.com`. Only explicitly
configured literal loopback HTTP (`127.0.0.1` or `[::1]`, not `localhost`) permits
development cookies. `WEB_DIR` is a separate trusted immutable app build root.
No browser assets, OAuth provider settings, deployment secrets or app UI are
provisioned by these routes.

`CONTROL_WEB_SESSION_KEYS` contains one to eight comma-separated `kid=key`
entries: unique 1–64-character letters/digits/underscore/hyphen ids and canonical
base64url 32-byte AES keys, at most 4096 characters total. They are deployment
secrets, never implicitly generated. They seal only the ten-minute sign-in
transaction cookie, with AES-256-GCM, random nonces and origin/purpose-bound
additional authenticated data. First key encrypts; all keys decrypt. Append a
new key before promoting it to first, and keep a retired key for ten minutes
after it last encrypted.

A browser session is a row in `remote_web_sessions`, not a cookie's contents.
Sign-in keeps the Supabase user id, Supabase session id and GitHub login, and
discards every Supabase and GitHub token, so there is no refresh token to rotate,
store or lose. The session cookie holds a random 32-byte handle (base64url). The
database stores only its SHA-256, and the CSRF token is a different SHA-256 of
the handle, so neither reveals it. The handle never changes: a lost response, an
aborted fetch, a suspended PWA, a restart or another replica cannot sign anyone
out. Any replica admits it with one `control_web_session_use` call and no process
memory.

A session lasts until it goes 90 days unused. Use slides that window: the
database records use at most hourly, and only then does the response renew the
cookie's 90-day Max-Age. A session ends, and its browser client is revoked, on
sign-out, when that client is revoked from any device, after 90 idle days, or
when its Supabase session ends (`auth.sessions` loses it). Ending a session also
deletes its Supabase session. Account deletion removes everything. A suspended
account is refused with 403 and keeps its session. Sign-in and client
registration sweep the owner's clients: idle sessions end, browser clients left
without a session are deleted, and so are clients revoked over a day ago.

Production cookies are `__Host-phosphor-session` and
`__Host-phosphor-transaction`: Secure, HttpOnly, SameSite=Lax, Path=/, no Domain.
Explicit loopback HTTP fixtures instead use `phosphor-dev-session` and
`phosphor-dev-transaction`, without Secure. A session cookie that is not a
handle (an older cookie format, for example) or whose handle has no live row is
cleared with 401. Unavailable services never clear a session.

Only requests whose Host matches the configured app host receive browser routes
or the app static root. Forwarded-Host is ignored; redirects always derive from
the configured origin, never a request header. Other hosts retain the site's
static handling and bearer-only API. App APIs reject any Authorization header
rather than ambiguously choosing between bearer and cookie. On the native/site
API, cookies are ignored and existing bearer authentication remains unchanged.
All private/auth responses are no-store. There are no CORS allowances.

### Browser interface

The shared subpath `@phosphor/shared/web-auth` owns route names, CSRF header and
safe browser response types. Requests use same-origin cookies; mutations send
`Content-Type: application/json`, exact app `Origin` and
`x-phosphor-csrf: <csrfToken>`. DELETE still has no body. Missing/mismatched Origin
or CSRF returns 403, including sibling-site origins. GETs with an explicitly
wrong Origin are refused too.

- `GET /api/auth/start?returnTo=/machines` navigates to Supabase's GitHub PKCE
  authorize route (`code_challenge_method=s256`). `returnTo` defaults to `/` and
  accepts only bounded local slash-separated alphanumeric/underscore/hyphen
  paths, not queries, fragments, dot segments or API paths. Initiate from the
  app itself; a cross-site/sibling-site Fetch Metadata initiation is refused.
  Already signed in, it redirects straight to `returnTo`. A failed start or
  callback never answers JSON: it redirects (303) to `/?signin-error=<code>` with
  the control error code, which the app reads, strips and explains.
- `GET /api/auth/callback?state=…&code=…` exchanges the bounded code using the
  encrypted transaction's verifier. State is embedded in the configured
  `redirect_to` callback query, not assumed to be arbitrary OAuth state echoed
  by Supabase. The callback must match the exact transaction. Supabase must allowlist this app callback URL
  including its state query. The production Supabase redirect configuration and
  real GitHub flow require separate deployment validation.
  A successful exchange creates the session and exactly one `kind=web` client in
  one `control_web_session_create` call, sets the cookie and redirects to the
  stored local path with 303. Arriving again while signed in redirects without
  another exchange.
- `GET /api/auth/session` returns
  `{user: {id, login}, clientId, csrfToken}`, 401 when signed out, expired or
  revoked, and 403 when the account is suspended. No token exists to return.
  Clients should treat 503 as a retryable service failure, not signed-out state.
- `POST /api/auth/signout` with JSON `{}` and the session's CSRF header clears
  the cookie after one `control_web_session_end` call ends the session, revokes
  this browser's client and deletes its Supabase session. It returns
  `{signedOut: true, remoteCleanup: "complete"}`. A session already gone answers
  401 and clears the cookie. An outage answers 503 and keeps the cookie, so a
  retry finishes the job. It does not sign out other devices or stop
  lanes. Existing Host grants may remain usable for their bounded lifetime;
  offline Hosts do not receive immediate revocation.
- `GET /api/v1/clients` uses the ordinary owner/account guard and returns
  `{clients: [{id, label, kind, revokedAt}]}`, at most 100 rows, active first.
  It also works for native bearer callers. `DELETE /api/v1/clients/:id` retains
  its owner-only behavior and can revoke another device.
- `DELETE /api/v1/me` deletes the account like the native route, then answers with
  a single cookie clear in place of any renewal.
- Browser requests cannot POST client registration or substitute a different
  `clientId` in `POST /api/v1/grants`. Use the id from `/api/auth/session` with
  the existing `{hostId, clientId}` grant API. The grant's session id is the
  browser session's Supabase session id.

Every cookie API request admits its session through `control_web_session_use`,
which checks the session, its client, the account and the Supabase session in one
statement. Refused sessions get 401 (403 when suspended). An unavailable database
fails closed with 503 and keeps the cookie. The grant RPC also locks and checks
the client at issuance. A refused session never re-registers; a fresh interactive
sign-in creates another device identity. Code exchange refuses redirects and has
a five-second deadline and a 64 KB response cap. Supabase's one-use code and the
PKCE verifier sealed in the transaction cookie are the replay boundary. Nothing in
browser sign-in is process-local, and no sign-in limit applies.

### App static policy

The site's marketing `/` and `/guides/`, guide redirect, caching and confinement
remain unchanged. The app root has its own policy and no-store responses. Its
SPA fallback requires GET/HEAD, `Accept: text/html` and a simple navigation path;
it never handles API paths, missing file assets, or assets/fonts/icons/_astro directories.
Both roots retain realpath/symlink confinement and hidden-file refusal.
App CSP allows bundled same-origin scripts (no inline scripts), same-origin
styles/fonts/images/manifest/workers, inline styles and data images. Network
sources are only self, `https://*.ts.net:*` and `wss://*.ts.net:*`; explicit ports
include the default Host 47615 and configured ports. This is defense in depth,
not Host authorization: the browser transport must use only the server-returned
enrolled endpoint and verify its enrolled Host key before accepting data.
Production HTTP/WS and arbitrary network domains are not permitted. Frames are
restricted to `blob:` sources only, never HTTP or same-origin API pages. The app
itself refuses both same-origin and cross-origin embedding with `X-Frame-Options:
DENY`. App static responses deliberately omit CSP `frame-ancestors`: WebKit
inherits that directive into Blob documents, incorrectly blocking these opaque
previews when it is `none`. API responses retain their separate restrictive CSP.
Do not reintroduce an inherited ancestor policy at the edge. A web
preview must use an opaque sandbox with neither `allow-scripts` nor
`allow-same-origin`, plus a document CSP preceding untrusted markup that refuses
scripts, connections, external styles/fonts and all non-data images. The parent
policy alone does not make arbitrary HTML safe. No artifact HTML is served by an
authorized preview route in Control; lane content stays on the direct Host path.
