# Web client

The browser client lives in `apps/web`. It imports the browser entry of
`libs/client-ui` (exported as `compact`); Desktop imports its native entry.
Full feature pages, remote creation, chat, approvals, resources and their stores
are shared production components, not parallel mobile implementations. Desktop's bootstrap, preload and local
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

### Configuration access and lane deletion

A Host's machine settings (**Settings → Configure → \<Host\>**, or **Machines → a Host →
Settings**) are the same shared sections as Desktop's. A signed-in
browser page holds configuration authority for a Host only after an explicit
per-page opt-in: **Enable configuration access**, confirmed in a dialog, calls
`hosts:settingsAccess`. The adapter (`apps/web/src/platform/settings.ts`) then asks
Control for that Host's grant with `configure: true`, checks that the signed grant
carries it, and reconnects so the Host admits `machine.configure`. If Control does
not sign it, the opt-in is rolled back and the existing lane access is unchanged.
This is Desktop's flow, `enableConfigurationAccess` in
`libs/host-client/src/settings.ts`, over the browser's grant cache.

The opt-in lives only in the control client's memory (`apps/web/src/platform/control.ts`):
it is never written to localStorage, IndexedDB or a cookie, and sign-out, an owner
or client change, a refused cookie and `dispose()` (closing or reloading the page)
clear it. Grants keep their five-minute lifetime and renew only while the page
runs. `hosts:settingsRead`, `hosts:settingsPatch`, `hosts:settingsCheck` and
`hosts:claudeAccount` use the shared `machineSettings` checks: each needs a ready
connection holding `machine.configure` and goes only to that Host, never to
Control, so a secret typed into a setting travels only over the verified Host
connection. `hosts:machineTask` runs reviewed programs in the browser's Host
terminals, as Desktop's `terminals.task` does. Nothing logs settings payloads.

`hosts:deleteLane` uses the shared `repositoryManagement.deleteLane`, as Desktop
does. The Host admits `lane.delete` only from the lane's controller, so a reader
sees the lane menu's Delete disabled with “Take control first.” until it takes
control.

Threat note: a signed-in browser session can now configure a Host (change pi
settings and connectors, install reviewed packages, move Claude accounts), but
only after a person confirms the per-page opt-in, and with the same Host
enforcement as Desktop. The Host's admission is unchanged: it grants
`machine.configure` only for a signed `configure` grant, regardless of client
kind, and drops it on an epoch change. A stolen cookie could already request a
configure grant from Control; this change does not widen what Control signs.

## Shared pages and responsive shells

Browser presentation switches at 900px: drawer navigation below that width,
persistent sidebar above it. Both hold one navigation body: the Phosphor
brand, Desktop's sidebar top (`SidebarNavigation`: New, the global page links,
then the **Lanes on** machine scope), the Host lane tree for
that scope (`RemoteLanes`, the same component and density as Desktop's sidebar),
Desktop's sidebar footer (`SidebarFooter`: the account menu and the Settings
gear), **Install Phosphor** where `installableApp` allows it, and a short note.
There is no Lanes link: the tree is in the navigation, and `/lanes` (the lane
header's Back, deep links) renders the same list as a page. The browser offers
the same pages as Desktop and no others: `SidebarNavigation` takes no shell
rows, there is no Inbox, and an old `/inbox` link opens the lane list. A lane
that needs you is marked on its row and in the machine scope, as on Desktop. The
machine scope is the only machine control; the header has none. It offers each
known Host and All machines, never This Mac (that needs `localLanes`), and lives
in the URL, so a choice replaces the location's `machine` (from a lane, it opens
that machine's lane list) and back, forward and deep links keep it. New opens
the New page for the machine in scope, or asks for one under All machines. In
the phone drawer, opening a page, a lane, New or Settings closes the drawer;
choosing a machine keeps it open on that machine's lanes. The header keeps Back
and New lane.
`Platform.formFactor` controls presentation only, so only primitives
(`components/`), `platform/` and the shells (`shell/`) read it; the
`phosphor/form-factor-in-layout` lint rule refuses it in features, navigation and
stores. A phone and a wide browser therefore get the same features, and every
Desktop/browser difference is a capability listed in `platform/Platform.test.ts`.
`platform/surfaceParity.characterization.test.tsx` checks that a Host lane's menu,
its Session options and Settings match on Desktop, in a wide browser and on a
phone. A shell passes layout down instead: the phone's lane header carries the
lane's controls (`ChatView`'s `laneControls`), and a list beside its detail, such
as Machine files, is the `ListDetail` primitive, one at a time on a phone.
`localLanes`, `nativeFiles`, `fileEditing` and `splitPanes` remain false in the
browser at every width. Modal/menu placement adapts without enabling native
editors or pane controls. Desktop retains its native sidebar and local workbench.
Below 900px a lane has one header bar: Back to its Host's lanes, then the lane
title with "Host · controller" under it (and the pane, when not Chat). The title
opens the lane menu, a bottom sheet (`ActionSheet`) that switches Chat, Files,
Changes, Artifacts and Terminal, then the lane's Session options (the same
list as Desktop's top bar, [chat](chat.md)), then its shared actions, the same
list as every Host lane row's menu without Open (see below), then New lane on
that Host. A confirmed action closes the sheet; a refusal stays to say why.
There is no drawer button, machine filter or pane tab strip inside a lane. A
reader sees a Take control bar where the composer would be. Wider browsers keep
the pane tabs, which end with the Session options button, and the control row
above the transcript; their header follows the lane title with its repository
and branch, as Desktop's top bar does ([UI shell](ui-shell.md#top-bar)).
History and popstate encode Host/lane identifiers, not filesystem paths. Missing machines, unavailable
capabilities and offline reads have explicit states; they never fall back to
This computer. Reading a lane does not acquire control. The real Host-backed
composer, controller controls and approval sheets are reused.

Machines, Skills, Routines and Artifacts are remote-only. Aggregate routines
preserve partial-state warnings and deduplicate qualified IDs. Incomplete
artifact aggregation reports an error rather than a misleading complete list.
Files and HEAD/working-copy comparisons are read-only. New lanes and existing
lane composers accept inline images; other browser file attachments are refused
before any lane creation/upload. The start screen's Repository menu offers Add
folder on MACHINE…, which opens Desktop's Host folder browser: it lists, creates
and adds folders under the Host's home over the same Host connection
(`hosts:listFolders`, `hosts:createFolder`, `hosts:addRepository`, through
`libs/host-client/src/repository-management.ts`). Host terminals work:
lane shells and the Machine page's shell
([terminal.md](terminal.md#machine-shells)), plus plain provider sign-in. Host
machine settings, including provider installation and Claude accounts, work after
[configuration access](#configuration-access-and-lane-deletion). File editing and
This Mac's settings are unavailable. Attention is in-app only, not OS push. A Host's
home folder opens read-only from **Machines → a Host → Machine files**.

`PageShell` owns each page's single heading, actions and close behavior;
`PageBody` supplies the shared width, gutters and scrolling for Machines,
Artifacts, Skills, Routines and Settings. `SidebarNavigation` (through
`PageLinks`/`NavigationItem`) supplies the same New row, global-page labels,
order, row presentation and Machines-row activity on machines outside the scope
in both clients. The footer's Settings gear opens the Settings page for the
machine in scope; the account menu offers Machines, Settings and Sign out. It
shows no keyboard shortcut, because the browser installs
none (`appShortcuts`), and no Cancel while signing in (`cancelSignIn`).
The Settings page frames Desktop's `SettingsSurface`: the same search field, section
navigation and sections, listed by platform capability
([settings](settings.md#sections-and-capabilities)). The browser shows Appearance,
Phosphor account, App installation and About, then **Configure** with the Host
machine settings of each known Host; it lists no This Mac sections.

### One lane row, list and menu

The browser's navigation and Lanes page, Host home (under the start composer) and
the machine page's lane preview render Desktop's Host lane components, not
copies ([Lanes](lanes.md#remote-lanes) owns their rules):

- `RemoteHostLanes` lists a Host: pinned lanes first under Pinned, then one
  `RemoteRepositoryGroup` per folder in the Host's order, and lanes whose folder
  left the Host in an explicit unavailable-folder group. A ready Host with no
  folders offers Add folder on MACHINE…. Each folder header has Search lanes,
  Workspace options (Add folder on MACHINE…, Remove from MACHINE, Move up, Move
  down, Select all lanes, Select merged lanes, Collapse lanes) and New lane in
  the folder, which opens the start composer with that folder chosen. Pages
  pass `density="page"` for touch-sized header buttons.
- `RemoteLaneRow` is the one Host lane row: title, elapsed time, worktree,
  branch, PR chip, marker and activity, as on Desktop. Unread attention is not
  labelled as a request for input, and a stopped process is not presented as a
  task result. A tap opens the lane through the browser's history. Right-click,
  the ContextMenu key, Shift+F10 or a touch long-press (one short vibration
  where the device can) opens its menu; below 900px the menu is a bottom sheet
  titled with the lane.
- The menu comes from `remoteLaneActions`, the same items and hints Desktop
  shows. Delete, Rename and Stop need control (“Take control first.”); Delete
  also needs `workspaces.write`. Bulk delete goes through the shared
  `RemoteBulkDelete`.

`RemoteWorkspacePage` composes the complete remote start page in both clients,
and its input is `StartComposer`, the one new-lane composer This Mac uses too
([remote creation](remote-desktop.md#machine-context-and-lane-creation)).
`RemoteStartView` supplies the Host target: it validates remembered
repositories, usable model choices and submission receipts. The root URL opens
New; one ready control-capable Host is selected and pinned into the URL, while
multiple targets require a choice. An explicit missing Host never silently
switches. Model precedence is last valid choice, a validated native preference
when available, then the first usable catalogue model. At every width the model
and thinking pickers are the lane composer's own split chip and searchable model
menu, which a phone opens as a bottom sheet, and the chip's tooltip discloses
which rule chose the model. No configured Host default or cross-device
preference sync is claimed. Isolation changes are memory-only in the browser,
preserving native preference persistence. Above the input sit the machine,
repository and isolation row; under it, the hints line and at most one note (a
warning, the connection it waits for, missing control or missing repository).
The composer keeps its field across reconnections to the same Host, locked while
it waits; only the model picker restarts with a new connection.

Both clients use bundled Inter and the same tokens. The shared loading surface
appears during browser account initialization, with explicit sanitized recovery;
fonts settle with the same bounded readiness as Desktop before feature views
mount. Phone controls retain 44px hit targets and 16px text-entry fields without
inflating all interface copy; wide screens use compact desktop density. Safe-area
insets and visual-viewport resize/scroll follow the on-screen keyboard.
HTML/SVG previews use revocable Blob URLs, an empty iframe sandbox and a leading
restrictive document CSP. Scripts, network, forms and authored navigation are
refused. The parent permits only `frame-src blob:` for these previews and blocks
app embedding with `X-Frame-Options: DENY`. Its CSP omits `frame-ancestors` because
WebKit inherits that restriction into otherwise valid Blob previews. Desktop's
artifact/file protocols and scripted artifact behavior are unchanged.

## Installation

The manifest supplies separate regular and Android `maskable` icons at 192px
and 512px. Maskable icons have an opaque, edge-to-edge graphite background;
the beacon fits inside the central 80%-diameter safe circle, so Android can apply
its launcher shape without a white surround or clipping the mark. iOS uses a
separate opaque 180px Apple touch icon and applies its own rounded corners.
All are generated from the canonical Desktop SVG with
`node tools/scripts/generate-icons.mjs --web-only`; no second logo is maintained.
Existing installations may keep an OS-cached icon; reinstalling after deployment
can be needed to see the new artwork. Headless checks verify the served pixels
and manifest, not a physical launcher's appearance or refresh timing.

**Install Phosphor** is available on sign-in, in navigation and in **Settings → App
installation**.
When the browser supplies a deferred install prompt, the action opens it once and
shares the pending state across entrypoints. Accepting the prompt is not reported
as completed installation; the browser's `appinstalled` event or a standalone
window establishes that. No automatic prompt is guaranteed or forced.

Otherwise the action shows instructions: Android Chrome's Install app/Add to Home
screen, iPhone/iPad Safari's Share → Add to Home Screen (Open as Web App if offered),
and desktop browser installation options. A standalone window hides the install
action. On iPhone an installed app may need its own sign-in. Installation adds no
native Desktop capability, background push, offline Host access or public tunnel.
Physical Android/iPhone installation and OS behavior remain separate acceptance
from synthetic install-event tests.

## Memory and offline behavior

Composer drafts and image blobs are bounded, owner-scoped memory, including
canonical remote-session tuple keys. Reloading does not restore those drafts.
The adapter persists only the theme preference, never credentials, transcripts
or draft contents. Browser font changes last until reload. Owner loss also clears
remembered creation targets/model choices and resets browser isolation. Unsupported
native file attachments are rejected.

The production service worker caches anonymous shell/static resources only.
API routes, OAuth callbacks, Host requests and non-GET requests bypass it.
Navigation is network-first with an anonymous shell fallback; navigation responses
are not cached. When account refresh is unreachable, the cached bootstrap shows
an anonymous recovery message and Retry, not signed-in content or a claim that
the account is signed out. Hashed asset caching is bounded. Updates do not force activation
or reload over an unsent draft. Offline shell availability is not offline Host
access or successful authentication.

### Sleep and reconnection

A dropped Host connection retries with jittered exponential backoff: 1 s,
doubling to 60 s, and at least 30 s after a rate limit
(`libs/host-client/src/retry.ts`). A phone that slept comes back with that
retry far away. So when the page becomes visible, returns from the back-forward
cache or comes back online, the adapter wakes every connection before it
re-reads the account and machine directory:

- A connection waiting out its backoff retries at once, except through a rate
  limit.
- A connection that still looks open is pinged. If no pong arrives within 8 s,
  it is replaced.

Directory heartbeats count only while the directory is fresh (two 30 s polls).
A directory that went stale while the page slept cannot mark a Host down.

While a Host is connecting or reconnecting, the UI keeps what it showed and
says what it waits for. Nothing typed then could be sent, so no field takes input:

- The lane list keeps the last-known lanes under a spinner note,
  `Reconnecting to <machine>…`. Their rows hold actions until the Host is ready.
- An open lane stays mounted, transcript and draft included. Its composer is
  locked (dimmed, `aria-busy`) under the same note, and the lane header holds
  its control buttons. It is never shown as read-only.
- Landing on a lane before its Host answers shows one loader that names the
  machine (`Connecting to <machine>…`), not an empty screen.
- The start screen locks its field under the same note, and its model chip reads
  `Connecting…`. It does not ask to connect a machine that is on its way back.

The first attempt says `Connecting`, a retry `Reconnecting`, in the notes
and the machine chip alike (`connectingTo` and `connectionLabel` in
`stores/remoteLanes.ts`). Only a Host that is down replaces
these with an instruction.

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
resource isolation, hostile previews and app-framing refusal. Responsive coverage
captures shared pages at 360/412/768/1440px in both themes, verifies Inter readiness
and containment, and rejects unsupported first-prompt files before mutation.
`reconnect.spec.ts` holds the Host unreachable (`holdHost`) and checks that the
lane, landing, start and lane-list screens wait, locked and labelled, at 400 and
1100px, then that the lane unlocks with its draft once the Host answers.
Auth/database/pi are synthetic. See [the harness contract](../apps/web/e2e/README.md). The browser job is
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

- Verify the additive
  `supabase/migrations/20261014120000_control_web_clients.sql` migration's content,
  permissions and hosted ledger mapping using the
  [activation runbook](#repeatable-activation). Do not replay an already installed
  schema. The deployment workflow does not apply migrations.
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
  in [Control deployment](control-plane.md#image-and-deployment). Its existence
  alone does not activate Web.
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

### Repeatable activation

This is an operator runbook, not an activation command. The repository helper
only inspects Auth configuration and optionally appends one redirect pattern.
It never enables Web, applies migrations, repairs a ledger, creates users,
revokes clients or seeds credentials. A deployed image and a present
`CONTROL_WEB_SESSION_KEYS` secret are not proof of an enabled app. With the
rollout flag unset/false, marketing content on the app hostname is expected.

1. **Verify the target and schema.** Use only the personal Supabase project
   `bzdbiswndlqvviiywsvj`, named exactly `phosphor`, with status `ACTIVE_HEALTHY`.
   Never select another product's project or organization/production AWS account
   `559050243724`. Recheck ownership in the authorized owner's dashboard; a name
   alone is not an identity check. Follow the
   [hosted schema checks and version mapping](control-plane.md#hosted-web-schema-verification).
   Keep the checked-in SQL canonical and stop on any mismatch.
2. **Preflight the OAuth redirect allowlist.** An authorized owner supplies a
   Supabase **Management API** token as `SUPABASE_ACCESS_TOKEN`, not the project's
   publishable/service-role key, and not a GitHub token. Use protected environment
   injection or a non-echoing Bash prompt in a private terminal (no recording,
   tracing, `env` dumps or credential-store searches):

   ```bash
   set +x
   IFS= read -r -s -p 'Supabase management token: ' SUPABASE_ACCESS_TOKEN; printf '\n'
   export SUPABASE_ACCESS_TOKEN
   node tools/scripts/web-activation.mjs --project-ref bzdbiswndlqvviiywsvj
   ```

   This performs only GETs. It verifies the fetched project ref, id, exact name
   and health before reading Auth config, then reports whether the exact callback
   pattern is present. No provider configuration or existing redirect values are
   printed. `--help` requires no token and makes no request. There is no custom
   project, API endpoint, callback URL, token argument or credentials-file option.

3. **Append only if approved.** Coordinate with other Auth-config editors first.
   In the same protected environment, explicitly request the narrow write:

   ```bash
   node tools/scripts/web-activation.mjs --project-ref bzdbiswndlqvviiywsvj --apply
   node tools/scripts/web-activation.mjs --project-ref bzdbiswndlqvviiywsvj
   unset SUPABASE_ACCESS_TOKEN
   ```

   Unset the token even if a command fails, and retire a temporary management
   token through the owner's normal process. Never put it in shell arguments,
   repository files, `.env`, CI artifacts or local Supabase config.

   The helper uses the documented [Management API](https://supabase.com/docs/reference/api/introduction)
   `GET /v1/projects/{ref}` and `GET/PATCH /v1/projects/{ref}/config/auth`
   ([public OpenAPI](https://api.supabase.com/api/v1-json)). The token needs project
   read and Auth read access; apply additionally needs Auth write permission.
   PATCH contains **only** `uri_allow_list`, preserving the fetched comma-separated
   string and appending:

   ```text
   https://phosphor-app.saccolabs.com/api/auth/callback\?state=*
   ```

   [Supabase redirect globs](https://supabase.com/docs/guides/auth/redirect-urls#use-wildcards-in-redirect-urls)
   interpret `?` as a wildcard, so `\?` matches the literal query delimiter.
   The single `*` covers the generated base64url state without allowing another
   path segment; there is no hostname/path globstar. This allowlists the
   `redirect_to` URL, not the eventual callback's extra authorization `code`.
   Control still validates the exact 43-character transaction state and refuses
   unexpected/duplicate query parameters. The helper does not decode OAuth state.
   Existing native/loopback redirects, site URL and GitHub provider settings stay
   intact. An exact existing entry makes even `--apply` a no-write success.

   All requests are fixed HTTPS with redirects refused, deadlines and bounded
   responses; errors never include upstream bodies, headers or tokens. Apply
   rechecks the allowlist before PATCH and reads it back afterwards. There is no
   documented conditional PATCH: **serialize concurrent Auth configuration edits**;
   the recheck cannot eliminate the final read/write race. On failure after PATCH,
   the write may have landed. Inspect securely and rerun preflight rather than
   restoring an old whole-config snapshot. Broader existing redirect patterns are
   preserved, not audited or tightened by this helper.

4. **Verify routing and prepare enabled acceptance.** Route both HTTPS origins to
   Control port 5015. Preserve the actual app `Host`, not `X-Forwarded-Host`;
   retain marketing `/` and `/guides/` on the site host. DNS/tunnel connectivity
   alone does not prove Host preservation. Overwrite `x-phosphor-edge` with the
   configured secret on both origins and preserve trusted `cf-connecting-ip`.
   Bypass edge caches for app navigations, manifest, worker, OAuth and private
   APIs: preserve origin `no-store`, never cache cookies/authenticated responses.
   Keep app static CSP without `frame-ancestors` and preserve
   `X-Frame-Options: DENY`; API CSP remains separate. Prepare a browser-capable
   enrolled Host with the exact app Origin admitted and the Pixel on Tailscale.
5. **Use the existing guarded deployment, not the helper, to enable.** Set the
   repository Actions variable `PHOSPHOR_WEB_ENABLED` to literal `true`, supply
   valid `CONTROL_WEB_SESSION_KEYS` through the secret store, and dispatch
   `.github/workflows/deploy-site.yml` on current `main` with `confirm=true`.
   Exact-head successful push CI, `site-production` environment approval,
   `SITE_DEPLOY_HOLD` and Skip-Release checks still apply. Do not bypass a hold;
   `ignore_skip_release` is only an explicit operator override of that footer.
   Enabled deployment selects the Web overlay and rebuilds the site's app link.
   From an authorized operator's GitHub CLI session (these commands mutate the
   repository variable and request deployment):

   ```bash
   gh variable set PHOSPHOR_WEB_ENABLED --repo agustinsacco/Phosphor --body true
   gh workflow run deploy-site.yml --repo agustinsacco/Phosphor --ref main -f confirm=true
   ```

   The workflow's anonymous smoke (also `node tools/scripts/site-web-smoke.mjs`)
   must pass, but proves only app/site routing, static headers and unsigned 401.

6. **Close the real gates before declaring activation accepted.** Initiate GitHub
   OAuth from the app, not the marketing site; verify callback with its state
   query, signed-in session, one bound web client, refresh and sign-out. A real
   OAuth flow cannot be tested while the rollout is disabled; treat enabling as
   a guarded acceptance window, not completion. Verify enrolled Host discovery,
   HTTPS/WSS proof, explicit control/send and revocation. On a physical Pixel,
   test installation, local-network permission, Tailscale reachability and
   sleep/reconnect. Record outcomes separately from schema checks and anonymous
   smoke; headless fixture success does not satisfy these gates.

If enabled smoke or any real gate fails, set `PHOSPHOR_WEB_ENABLED=false` (or
unset it) and dispatch the same guarded current-main deployment with
`confirm=true`. This rebuilds the link-free site and reapplies the base, removing
Web env references. It does not delete keys, undo additive SQL/redirect entries,
revoke existing clients or immediately invalidate five-minute Host grants.

```bash
gh variable set PHOSPHOR_WEB_ENABLED --repo agustinsacco/Phosphor --body false
gh workflow run deploy-site.yml --repo agustinsacco/Phosphor --ref main -f confirm=true
```

### Repeatable local fixtures

Use the existing isolated Supabase stack, not hosted data. With Docker and the
repository dependencies installed, run the stack suites **sequentially**:

```bash
npm run db:start
npm run test:control-db
npm run test:auth-stack
npm run test:control-stack
npm run db:stop
```

Always stop the disposable stack after testing (including failures); `db:stop`
uses `--no-backup`. `supabase/config.toml` pins `phosphor-control-test`, API 54351,
DB 54352, disabled persistent seeding and fake GitHub credentials only. The stack
runners obtain local test keys without printing them; never publish raw CLI
status/start output. pgTAP fixtures use synthetic users and clean up/roll back;
`supabase/tests/fixtures/fake-github.cjs` supplies deterministic provider behavior.
The auth runner exercises Desktop PKCE/loopback sign-in, and the control runner
exercises real local Auth/RPC with two synthetic owners and signed Host traffic.
They remove their fake-provider container and leave the stack for `db:stop`.
See [local validation](remote-development.md#local-validation).

There is **no full local PWA-to-real-Supabase OAuth seed command**. These stack
suites do not test the PWA callback allowlist. `npm run test:e2e:web` separately
uses the [browser fixture](../apps/web/e2e/README.md): production routes and a real
disposable Host/fake pi, but synthetic Auth/database ports and test-only socket
mapping. Do not confuse those fixtures with real OAuth, TLS/Tailscale or mobile
acceptance. Never seed a real user, session, management token or production
secret into local config. The activation helper's own offline check is:

```bash
npx vitest run tools/scripts/web-activation.test.ts --maxWorkers=2
```
