# Browser acceptance

Run from the repository root with root, Control and Web dependencies installed
and Playwright Chromium/WebKit available:

```sh
WEB_E2E_EVIDENCE=/absolute/path/to/evidence \
  npx playwright test --config apps/web/playwright.config.ts
npx tsc --noEmit -p apps/web/e2e/tsconfig.json
npx eslint apps/web/e2e apps/web/playwright.config.ts
```

The evidence directory defaults to `/tmp/phosphor-web-e2e`. Global setup builds
the real Host CLI, unmodified production Web entry and a separate test entry.
Only the latter goes in `fixture-build/` beneath the evidence directory. Tests
use one worker, no retries and no screenshot baselines. Each engine captures
400px/1100px light/dark screenshots under `results/`; transcript readiness and
fonts are awaited and transient animations disabled for captures. Cache-path,
framing and preview-policy evidence is saved alongside results. Playwright clears
`results/` on each invocation: copy it elsewhere before preserving a red run.
Traces/videos are disabled because they can contain cookies or grants.

## Boundaries

- `fixture.ts` runs actual Control routes (including browser start/callback,
  sealed HttpOnly cookies, CSRF, directory, signed grants and signed Host
  requests). Only its Auth/database ports are synthetic; the fixture provider
  validates the actual PKCE challenge/verifier. No Supabase or GitHub is called.
- Each authenticated test launches the real Host CLI with a disposable HOME,
  config, fresh Ed25519 identity, repository pair and the existing Host fake-pi
  executable. The Host owns the real session runtime, files and artifact store.
  The seeding client writes two distinct lanes through the real Host protocol.
  Setup failures and test teardown close sockets/listeners, stop Host, and remove
  disposable state and generated keys.
- `client/main.tsx` installs actual `createBrowserApi` before importing actual
  shared `CompactApp`. Its **only** injected adapter port maps the single
  `wss://fixture.ts.net/v1/stream` endpoint to the same-origin loopback fixture
  upgrade. The byte-forwarding proxy preserves browser Origin and changes only
  path/Host authority for the real Host listener. Grants, browser crypto,
  challenge proof, capability checks and lane/resource routers are unchanged.
- This mapping is test-only, not a production hook, TLS proxy or security bypass.
  It establishes protocol integration, **not** HTTPS/WSS, certificate, Tailscale,
  real OAuth, mobile installation or physical-device acceptance.
- Production smoke and anti-framing tests serve the unmodified production build
  with **no injected adapter**. The framing parents are deliberately permissive
  inert fixture pages: child protection must work independently of parent CSP.
- Hostile markup mounts the actual `SandboxedHtml` under the actual compact
  platform. It tests safe HTML/SVG readability, an empty sandbox, Blob source,
  removed executable/navigation markup, denied outbound resources, clicks,
  dialogs and popups. External HTTP requests are blocked and fail a tripwire.
  No nonlocal destinations are contacted.

## Coverage and limits

Both engines exercise cookie/CSRF, verified Host read without control, explicit
control/send, socket interruption/reconnect, real file/artifact lane isolation,
owner-scoped draft loss, outstanding Host approval cleanup, anonymous offline
recovery, authenticated cache exclusion, and a waiting worker update that does
not replace an unsent draft. At 400px and 1100px, `files.spec.ts` edits and
saves a Host lane's file (a phone's plain field, Monaco when wide), keeps a draft
over a competing Host write, previews an image from a Blob under the served app
CSP and downloads a file; on a phone, Back, Edit and Download each take a whole
44px tap. `artifacts.spec.ts` compares two Host artifact versions at both widths
(Monaco when wide, wrapping lines on a phone), downloads the selected version's
raw HTML, then writes the latest version into that lane's Files. It checks the
phone's primary controls take 44px taps and secondary actions use one sheet;
PDF stays absent and the HTML iframe's sandbox stays empty. Offline navigation cuts the disposable fixture's
HTTP connections instead of relying on WebKit's offline emulation. Recovery is
anonymous with Retry, never a claim that offline authentication succeeded or that
a missing network response proves sign-out. Offline assets are warmed under the
worker first; first-install prefetch is not claimed.

Resource isolation uses two lanes/repositories on one Host, not a two-Host
network. Reconnect is a socket interruption, not OS suspend/resume. Auth/database
ports do not validate deployment migrations or real revocation propagation. The
production Host's five-minute grant lifetime remains unchanged.

Root scripts, Nx registration and CI are intentionally outside this harness's
ownership. Integration should add a browser e2e command for this config, include
its explicit TypeScript check, install both engines/dependencies in CI, set
`WEB_E2E_EVIDENCE` to a runner-owned directory and upload the selected results.
Never enable traces or upload disposable identity directories.

## Selected Host Brain

`brain.spec.ts` uses the same compact app, real Control grants and byte-forwarding
proxy, with two independent in-process Host API listeners and signed Host identities.
These listeners run the actual Brain wire adapter and lane subscription protocol;
knowledge, source transcripts and Agent data come from synthetic ports, and the
requesting CLI principal uses the adapter's local-link fixture. No model, live
Brain store, installed service or OS-level socket attestation is exercised.
The spec deliberately reuses the same entity, memory and lane IDs across Hosts.
