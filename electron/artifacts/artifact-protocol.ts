import { protocol } from 'electron'
import { createHash } from 'node:crypto'
import { buildArtifactDocument } from './artifact-skeleton'

/**
 * Serving model-authored HTML on its own origin, so it can run JavaScript
 * without inheriting — or weakening — the app's Content Security Policy.
 *
 * ## Why a custom scheme, and not srcdoc / blob: / data:
 *
 * The artifact panel renders HTML in `<iframe sandbox="allow-scripts">`. That
 * looked like it permitted scripts and did not: a `srcdoc` document INHERITS
 * the embedder's policy container, and `src/index.html` sets
 * `script-src 'self'`, so every inline script was refused and the sandbox
 * attribute was a no-op. Measured on Electron 43:
 *
 *     Executing inline script violates the following Content Security Policy
 *     directive 'script-src 'self''. The action has been blocked.
 *
 * `blob:` and `data:` do not help — HTML treats them as local schemes and they
 * inherit the same way. Only a real, non-local scheme gets its own policy, so
 * the document has to be *served* rather than embedded.
 *
 * ## Why this is tighter than what it replaces
 *
 * The response below carries `default-src 'none'`, and the iframe keeps
 * `sandbox="allow-scripts"` WITHOUT `allow-same-origin`, which makes the
 * document's security origin opaque. Verified end-to-end under Electron 43:
 *
 * | vector                          | result             |
 * | ------------------------------- | ------------------ |
 * | `window.origin`                 | `"null"` (opaque)  |
 * | `localStorage`, `document.cookie` | `SecurityError`  |
 * | parent DOM, sibling artifact DOM  | `SecurityError`  |
 * | `top.location =`                | `SecurityError`    |
 * | `fetch`, `sendBeacon`, `WebSocket` | blocked by CSP  |
 * | remote `<img>`                  | blocked by CSP     |
 *
 * So an artifact gains scripting and loses ALL network reach. Under the old
 * inherited policy it had `connect-src 'self' ws:` — it simply had no way to
 * use it. Net, this is a reduction in what model-authored HTML can do.
 *
 * `sendBeacon` returning `true` and `new WebSocket()` not throwing are both
 * false negatives when probing this: the request is queued and refused
 * asynchronously. Trust the console violations, not the return values.
 */

/**
 * The policy every artifact document is served with.
 *
 * `form-action` matters as much as `connect-src` here: a form POST is a
 * NAVIGATION, so `default-src`/`connect-src` do not cover it, and it would be
 * an exfiltration channel that none of the fetch-shaped tests would catch.
 */
const ARTIFACT_CSP = [
  "default-src 'none'",
  // Model-authored HTML is inline by construction; a nonce would have to be
  // threaded into content Phosphor does not author. 'unsafe-eval' costs nothing
  // extra once inline script is allowed, and charting code expects it.
  "script-src 'unsafe-inline' 'unsafe-eval'",
  "style-src 'unsafe-inline'",
  'img-src data: blob:',
  'font-src data:',
  'media-src data: blob:',
  "frame-src 'none'",
  "form-action 'none'",
  "base-uri 'none'",
].join('; ')

export const ARTIFACT_SCHEME = 'phosphor-artifact'

/**
 * Staged documents, keyed by content hash.
 *
 * Hashing rather than minting a token per render keeps re-renders idempotent —
 * the same artifact version always resolves to the same URL, so the iframe is
 * not torn down and rebuilt on every parent re-render.
 */
const staged = new Map<string, string>()

/** Bounded so a long session full of large artifacts cannot grow main's heap. */
const MAX_STAGED = 32

/**
 * Wrap markup in the house style and stage the result.
 *
 * Hashing the FINISHED document, not the model's markup, is what makes a theme
 * switch reach an open artifact: same markup under a different theme is a
 * different document, so it gets a different URL and the iframe reloads.
 * Hashing the markup alone would leave the old theme on screen until the
 * artifact itself changed.
 */
export function stageArtifactHtml(html: string, theme: 'light' | 'dark' = 'dark'): string {
  const document = buildArtifactDocument(html, theme)
  const key = createHash('sha256').update(document).digest('hex').slice(0, 32)
  // Re-insert so the eviction order below is least-recently-used, not
  // first-written: the artifact you are actually looking at must not be the
  // one evicted while you look at it.
  staged.delete(key)
  staged.set(key, document)
  while (staged.size > MAX_STAGED) {
    const oldest = staged.keys().next().value
    if (oldest === undefined) break
    staged.delete(oldest)
  }
  return `${ARTIFACT_SCHEME}://doc/${key}`
}

/**
 * Must run BEFORE `app.whenReady()`.
 *
 * `standard` gives the scheme a parseable origin (without it the iframe is not
 * treated as an ordinary document); `secure` keeps it a secure context so it
 * is not downgraded as mixed content. CORS stays off — the document has no
 * network access to make cross-origin requests with.
 */
export function registerArtifactScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: ARTIFACT_SCHEME,
      privileges: { standard: true, secure: true, corsEnabled: false, supportFetchAPI: false },
    },
  ])
}

/** Must run AFTER `app.whenReady()`. */
export function registerArtifactProtocol(): void {
  protocol.handle(ARTIFACT_SCHEME, (request) => {
    const key = new URL(request.url).pathname.replace(/^\//, '')
    const html = staged.get(key)
    if (html === undefined) {
      // A stale iframe pointing at an evicted document. Answer with an inert
      // page rather than a network error, so the panel shows something honest.
      return new Response('<!doctype html><title>Artifact unavailable</title>', {
        status: 404,
        headers: {
          'content-type': 'text/html; charset=utf-8',
          'content-security-policy': ARTIFACT_CSP,
        },
      })
    }
    return new Response(html, {
      headers: {
        'content-type': 'text/html; charset=utf-8',
        'content-security-policy': ARTIFACT_CSP,
        // Belt and braces: the sandbox attribute already makes the origin
        // opaque, but a future call site that forgets it still gets no framing
        // from anywhere but this app.
        'x-content-type-options': 'nosniff',
      },
    })
  })
}

/** Exported for tests. */
export const __testing = { ARTIFACT_CSP, staged, MAX_STAGED }
