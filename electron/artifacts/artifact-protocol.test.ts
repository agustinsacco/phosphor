import { describe, it, expect, beforeEach, vi } from 'vitest'

// electron is not loadable under vitest; only the pure staging surface is
// exercised here. The security properties themselves are not unit-testable —
// they are Chromium's, and were measured directly (see the module comment).
vi.mock('electron', () => ({ protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() } }))

const { stageArtifactHtml, __testing } = await import('./artifact-protocol')

beforeEach(() => __testing.staged.clear())

describe('stageArtifactHtml', () => {
  it('returns a URL on the artifact scheme', () => {
    expect(stageArtifactHtml('<p>hi</p>')).toMatch(/^phosphor-artifact:\/\/doc\/[0-9a-f]{32}$/)
  })

  it('is idempotent, so a re-render does not rebuild the iframe', () => {
    const a = stageArtifactHtml('<p>same</p>')
    const b = stageArtifactHtml('<p>same</p>')
    expect(a).toBe(b)
    expect(__testing.staged.size).toBe(1)
  })

  it('gives different content different URLs', () => {
    expect(stageArtifactHtml('<p>a</p>')).not.toBe(stageArtifactHtml('<p>b</p>'))
  })

  it('gives the same content a different URL per theme', () => {
    // The house stylesheet is injected here, so the theme is part of the
    // staged document. Same URL across themes would strand an open artifact
    // on the theme it was first rendered in.
    expect(stageArtifactHtml('<p>x</p>', 'dark')).not.toBe(stageArtifactHtml('<p>x</p>', 'light'))
  })

  it('serves the wrapped document, not the raw markup', () => {
    const url = stageArtifactHtml('<p>x</p>', 'dark')
    const served = __testing.staged.get(url.split('/').pop()!)
    expect(served).toContain('data-theme="dark"')
    expect(served).toContain('--art-bg')
  })

  it('bounds the map so a long session cannot grow main’s heap', () => {
    for (let i = 0; i < __testing.MAX_STAGED + 10; i++) stageArtifactHtml(`<p>${i}</p>`)
    expect(__testing.staged.size).toBe(__testing.MAX_STAGED)
  })

  it('evicts least-recently-staged, not first-written', () => {
    const first = stageArtifactHtml('<p>keep-me</p>')
    for (let i = 0; i < __testing.MAX_STAGED - 1; i++) stageArtifactHtml(`<p>filler-${i}</p>`)
    // Re-staging is what a re-render of the open artifact does; it must renew.
    stageArtifactHtml('<p>keep-me</p>')
    stageArtifactHtml('<p>overflow</p>')
    expect(__testing.staged.has(first.split('/').pop()!)).toBe(true)
  })
})

describe('served policy', () => {
  const csp = __testing.ARTIFACT_CSP

  it('denies everything by default', () => {
    expect(csp).toContain("default-src 'none'")
  })

  it('allows inline script — the entire point', () => {
    expect(csp).toContain("script-src 'unsafe-inline'")
  })

  it('grants no network reach of any kind', () => {
    // No connect-src, so it falls back to default-src 'none'. Asserting the
    // absence is the point: adding one later would silently open fetch,
    // sendBeacon and WebSocket at once.
    expect(csp).not.toContain('connect-src')
    expect(csp).not.toMatch(/https?:/)
  })

  it('blocks the exfiltration channels CSP does not cover by default', () => {
    // A form POST is a navigation, so connect-src/default-src do NOT cover it.
    expect(csp).toContain("form-action 'none'")
    expect(csp).toContain("base-uri 'none'")
    expect(csp).toContain("frame-src 'none'")
  })

  it('permits only inline images, never remote ones', () => {
    expect(csp).toContain('img-src data: blob:')
  })
})
