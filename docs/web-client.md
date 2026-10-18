# Web client

The browser client lives in `apps/web`. It imports the compact entry of
`libs/client-ui`; Desktop imports the expanded entry of the same library.
Chat, approvals, resources and their stores are shared production components,
not a second transcript implementation. Desktop's bootstrap, preload and local
lanes remain separate and work without account sign-in.

## Account and Host boundary

The browser adapter is installed before the UI imports. Account requests use
same-origin HttpOnly cookies and session-bound CSRF, never native bearer tokens.
The app origin is isolated from the public site and native API. See
[Control](control-plane.md) for cookie admission, OAuth and configuration.

Directory records authorize discovery, not lane access. Short-lived grants stay
in memory; direct Host HTTPS/WSS connections verify the enrolled key and the
challenge proof before exposing data. `libs/host-client` supplies the same
connection, projection and typed resource routers as Desktop. Completion fences
follow the owner and the operation's actual Host, not unrelated connections.
The Host must admit the exact browser Origin; native no-Origin clients remain
supported. There is no public Host tunnel or control-plane lane-content relay.

`IPC_WEB` classifies every unchanged `PhosphorApi` invoke as supported remote,
browser-local or explicitly unsupported. It is not an arbitrary IPC tunnel.
Account loss clears adapter authority and UI drafts/prompts before another owner
mounts. Sign-out warnings distinguish confirmed local logout, pending remote
cleanup and unconfirmed network outcomes. A retry returning 401 does not prove
remote cleanup completed or revoke previously issued grants immediately.

## Compact surfaces

The compact shell is used at every browser width. History and popstate encode
Host/lane identifiers, not filesystem paths. Missing machines, unavailable
capabilities and offline reads have explicit states; they never fall back to
This computer. Reading a lane does not acquire control. The real Host-backed
composer, controller controls and approval sheets are reused.

Machines, Skills, Routines and Artifacts are remote-only. Aggregate routines
preserve partial-state warnings and deduplicate qualified IDs. Incomplete
artifact aggregation reports an error rather than a misleading complete list.
Files and HEAD/working-copy comparisons are read-only. The first-prompt form
has no attachment picker; images can be attached through the lane composer.
Native terminals, file editing, provider installation/login and native settings
are unavailable. Attention is in-app only, not OS push.

Compact controls use touch-sized targets, 16px inputs, safe-area insets and a
visual-viewport-aware layout. Desktop retains its existing density and shell.
HTML/SVG previews use revocable Blob URLs, an empty iframe sandbox and a leading
restrictive document CSP. Scripts, network, forms and authored navigation are
refused. The parent permits only `frame-src blob:` for these previews and blocks
app embedding with `X-Frame-Options: DENY`. Its CSP omits `frame-ancestors` because
WebKit inherits that restriction into otherwise valid Blob previews. Desktop's
artifact/file protocols and scripted artifact behavior are unchanged.

## Memory and offline behavior

Composer drafts and image blobs are bounded, owner-scoped memory, including
canonical remote-session tuple keys. Reloading does not restore those drafts.
The adapter persists only the theme preference, never credentials, transcripts
or draft contents. Unsupported native file attachments are rejected.

The production service worker caches anonymous shell/static resources only.
API routes, OAuth callbacks, Host requests and non-GET requests bypass it.
Navigation is network-first with an anonymous shell fallback; navigation responses
are not cached. When account refresh is unreachable, the cached bootstrap shows
an anonymous recovery message and Retry, not signed-in content or a claim that
the account is signed out. Hashed asset caching is bounded. Updates do not force activation
or reload over an unsent draft. Offline shell availability is not offline Host
access or successful authentication.

## Build and deployment

`npm run web:build` produces `apps/web/dist`; `npm run typecheck:web` checks the
browser and worker separately. Root unit selection includes Web and shared UI.
The build rejects Node, Electron, session-runtime and fixture dependencies.
The combined Control image has separate site, Control and Web build stages and
keeps `/` and `/guides/` on the site origin. The app uses
`phosphor-app.saccolabs.com`; `PHOSPHOR_BUILD_SHA` identifies its shell cache.

`npm run test:e2e:web` runs Chromium and WebKit against the production bootstrap
and a separate authenticated fixture that maps only socket transport to a disposable
real Host. It exercises cookie/CSRF boundaries, Host proof, control/send, owner cleanup,
resource isolation, hostile previews and app-framing refusal. Auth/database/pi are
synthetic. See [the harness contract](../apps/web/e2e/README.md). The browser job is
required by CI; `npm run validate` includes it unless `SKIP_E2E=1`. The combined-image
check also verifies app/site Host-header routing, manifest, worker and API headers.

### Gated production rollout

Deploying the image alone does not enable browser sign-in. Deploy Site reads the
repository variable `PHOSPHOR_WEB_ENABLED`: unset/empty defaults to `false`; only
literal `true` or `false` is accepted otherwise. An invalid value fails before
publishing or deploying. The validated value gates both the site build's
**Open the app** link and the runtime Web overlay. The link goes only to
`https://phosphor-app.saccolabs.com/`, never to a sibling-origin auth endpoint.
The app itself initiates same-origin sign-in. Default site builds hide the link,
so absent app DNS does not expose a broken entry point.

The Docker argument `PHOSPHOR_WEB_ENABLED` is public, boolean and used only by
the Astro build as `PUBLIC_PHOSPHOR_WEB_ENABLED`. Browser credentials are never
build arguments. `PHOSPHOR_BUILD_SHA` still identifies the Web shell cache.
Runtime configuration and key handling are described in
[Control deployment](control-plane.md#image-and-deployment).

Before an operator sets the repository variable to `true`, separately verify:

- Review and apply the additive
  `supabase/migrations/20261014120000_control_web_clients.sql` migration to the
  explicitly verified Supabase target and reconcile its migration ledger.
  The deployment workflow does not apply migrations.
- Allowlist the app's `/api/auth/callback` URL including its state query in
  Supabase, and verify the real GitHub OAuth flow. Do not initiate OAuth from
  the marketing site's origin.
- Provision app DNS and HTTPS/tunnel routing to the same Control service on
  port 5015, preserving the app's **Host** header (Forwarded-Host is ignored).
  Keep the marketing origin routed to the site.
- Configure edge authentication-header rules for **both** origins: overwrite
  `x-phosphor-edge` with the configured edge secret and preserve trusted
  `cf-connecting-ip`. Do not add CSP `frame-ancestors` to app static responses;
  WebKit inherits it into Blob previews. Preserve `X-Frame-Options: DENY`.
- Supply the `CONTROL_WEB_SESSION_KEYS` repository secret in the strict format
  below. Its existence alone does not activate Web.
- Install a browser-capable Host that admits the exact app Origin, and verify
  physical Pixel/Android installation, OAuth, device Tailscale reachability,
  local-network permission, Host proof, send/control and sleep/reconnect.

These are external rollout gates, **not established by repository or headless
checks**. No production deployment or physical-device acceptance is implied.
After rollout the enabled-only anonymous smoke checks app root, manifest, worker,
no-store/framing headers and unsigned session denial, and distinguishes app
routing from site `/` and `/guides/`. It does not start OAuth or store cookies.

To disable, set the variable to `false` (or unset it) and run the guarded deploy
again: it rebuilds the site without the link and applies the base Deployment,
omitting all three Web variables. It does not delete live keys or revoke
already-issued Host grants. The regular exact-head CI, environment and hold
checks still apply to enabling, disabling and key rotation.
