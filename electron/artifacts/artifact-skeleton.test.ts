import { describe, it, expect } from 'vitest'
import { buildArtifactDocument, __testing } from './artifact-skeleton'

const { ARTIFACT_STYLE } = __testing

describe('buildArtifactDocument — fragments', () => {
  it('wraps a fragment in a real document', () => {
    const doc = buildArtifactDocument('<p>hi</p>', 'dark')
    expect(doc.startsWith('<!doctype html>')).toBe(true)
    expect(doc).toContain('<body><p>hi</p></body>')
    expect(doc.endsWith('</html>')).toBe(true)
  })

  it('stamps the resolved theme on the root element', () => {
    expect(buildArtifactDocument('<p>hi</p>', 'light')).toContain(
      '<html lang="en" data-theme="light">',
    )
    expect(buildArtifactDocument('<p>hi</p>', 'dark')).toContain(
      '<html lang="en" data-theme="dark">',
    )
  })

  it('injects the house stylesheet ahead of the content, so the model still wins', () => {
    const doc = buildArtifactDocument('<style>body{color:red}</style><p>hi</p>', 'dark')
    expect(doc.indexOf('--art-bg')).toBeLessThan(doc.indexOf('body{color:red}'))
  })
})

describe('buildArtifactDocument — a document the model wrote in full', () => {
  const full = '<!doctype html><html><head><title>t</title></head><body><p>hi</p></body></html>'

  it('does not nest it inside a second document', () => {
    const doc = buildArtifactDocument(full, 'dark')
    expect(doc.match(/<html/gi)).toHaveLength(1)
    expect(doc.match(/<body/gi)).toHaveLength(1)
  })

  it('injects the stylesheet into the head it already has', () => {
    const doc = buildArtifactDocument(full, 'dark')
    expect(doc.indexOf('--art-bg')).toBeLessThan(doc.indexOf('<title>'))
  })

  it('stamps the theme onto the existing root element', () => {
    expect(buildArtifactDocument(full, 'light')).toContain('<html data-theme="light">')
  })

  it('overrides a data-theme the model guessed at', () => {
    const guessed = '<!doctype html><html lang="en" data-theme="dark"><body>x</body></html>'
    const doc = buildArtifactDocument(guessed, 'light')
    expect(doc).toContain('<html lang="en" data-theme="light">')
    // Only the root tag — the sheet's own selectors mention both themes.
    expect(doc.match(/<html\b[^>]*>/i)![0]).not.toContain('"dark"')
  })

  it('gives a headless document a head to hold the sheet', () => {
    const doc = buildArtifactDocument('<html><body>x</body></html>', 'dark')
    expect(doc).toContain('<head>')
    expect(doc.indexOf('--art-bg')).toBeLessThan(doc.indexOf('<body>'))
  })

  it('treats leading whitespace and a bare <html> as a full document', () => {
    expect(__testing.looksLikeFullDocument('\n  <!DOCTYPE HTML>\n<html>')).toBe(true)
    expect(__testing.looksLikeFullDocument('<html lang="en">')).toBe(true)
    // Not a document: the fragment path must stay the common one.
    expect(__testing.looksLikeFullDocument('<div class="wrap">')).toBe(false)
    expect(__testing.looksLikeFullDocument('<htmlish>')).toBe(false)
  })
})

describe('the injected stylesheet', () => {
  it('is dark on bare :root, with light as the override', () => {
    // The inverse of the usual advice, and deliberate: this surface is dark by
    // design. Flipping it would silently re-theme every artifact.
    expect(ARTIFACT_STYLE).toMatch(/:root\{\s*color-scheme:dark/)
    expect(ARTIFACT_STYLE).toContain(':root[data-theme="light"]')
  })

  it('lets Phosphor’s own theme beat the OS in both directions', () => {
    // The media query is guarded, so a dark stamp survives an OS set to light;
    // the attribute rule comes later in the sheet, so it beats OS dark too.
    expect(ARTIFACT_STYLE).toContain('@media (prefers-color-scheme:light)')
    expect(ARTIFACT_STYLE).toContain(':root:not([data-theme="dark"])')
  })

  it('carries the validated series and ramp slots in both modes', () => {
    for (const token of ['--art-s1', '--art-s5', '--art-r1', '--art-r5']) {
      // Once in the dark block, once per light stamp (media query + attribute).
      expect(ARTIFACT_STYLE.split(`${token}:`).length - 1).toBe(3)
    }
  })

  it('keeps the app’s --px-* namespace out of it', () => {
    // A --px-* token here would make this a sixth satellite copy of the app
    // neutrals (docs/style-guide.md). It is its own surface on purpose.
    expect(ARTIFACT_STYLE).not.toContain('--px-')
  })

  it('loads no font over the network — the CSP allows none', () => {
    expect(ARTIFACT_STYLE).not.toContain('@import')
    expect(ARTIFACT_STYLE).not.toContain('@font-face')
    expect(ARTIFACT_STYLE).not.toMatch(/https?:/)
  })
})
