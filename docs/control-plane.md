# Control plane

`apps/control` is a plain Node 22 server. It serves the built Astro site and the
shared JSON contract in `libs/shared/src/control-api.ts`. It stores identity
and machine metadata only. It does not handle prompts, transcripts, files,
repository names or provider credentials. It does not enable remote execution.
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
  except a stopping beat. Accepted beats return the thirty-second interval.
- `POST /api/v1/hosts/self/revoke`: Host-signed removal, body exactly `{}`,
  returning 204 with no body. Revoked and unknown Hosts return 410.

Every user route except `/me` checks account suspension and refuses it with 403.
Key conflicts and the per-account active Host limit return 409. All request and
response fields pass through the shared contract's parsers; unknown fields are
not returned or stored.

Every API response is JSON with `no-store`, `nosniff`, `no-referrer`, a CSP that
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

Site GET and HEAD use `$uri`, then `$uri/index.html`. Misses use the site's
`404.html` with status 404. There are no directory listings. Encoded separators,
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
is validated before reaching the wire. Logs include timestamp, request id,
method, route pattern, status, duration and actor only, never headers, bodies,
concrete unknown paths, tokens, user codes or keys.

The reusable sliding-window limiter has a 10,000-key cap. At capacity it sweeps
expired windows and refuses new keys with 429 rather than evicting live windows.
Enrollment creates are limited to ten per hour per IP before signature checking
or nonce consumption. Polls are limited to sixty per minute per IP before the
body is parsed, then to one per two seconds per parsed enrollment id, both
before signature checking; Hosts sharing an address share the first limit.
Failed lookups and approvals share ten failures per fifteen minutes per user.
Guesses still awaiting the database count against that budget, so concurrent
requests cannot exceed it. Successes do not spend it. Once exhausted, both
routes return 429, even for a correct code, until a failure leaves the window.
Proxy IP selection trusts a valid `cf-connecting-ip` only when configured for
Cloudflare; otherwise it uses the socket address. All in-memory guards are
process-local. Run a single replica; rollout overlap is not cross-process replay
protection.

## Configuration and local use

| Variable                   | Default                | Constraint                                                   |
| -------------------------- | ---------------------- | ------------------------------------------------------------ |
| `PORT`                     | `5015`                 | 0 through 65535; 0 selects a test port                       |
| `SITE_DIR`                 | `/app/site`            | Trusted built site directory                                 |
| `SUPABASE_URL`             | Hosted Phosphor origin | HTTPS, or HTTP on localhost, 127.0.0.1 or [::1] only         |
| `SUPABASE_PUBLISHABLE_KEY` | Hosted publishable key | Public Auth apikey                                           |
| `SUPABASE_SECRET_KEY`      | Unset                  | Secret RPC apikey; never put it in a URL or command argument |
| `CONTROL_TRUST_PROXY`      | `none`                 | `none` or `cloudflare`                                       |

```bash
npm run site:build
npm run build:control
SITE_DIR=apps/site/dist node apps/control/dist/server.mjs
```

For local Supabase, use only the isolated `phosphor-control-test` stack described
in [remote-access.md](remote-access.md#local-validation). A protected environment
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
