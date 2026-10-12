import { readFileSync } from 'node:fs'
import { describe, it, expect } from 'vitest'
import { buildArtifactDocument, __testing } from './artifact-skeleton'

const { ARTIFACT_STYLE, ARTIFACT_PRINT_STYLE } = __testing

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
    expect(ARTIFACT_STYLE).toMatch(/:root\{\s*color-scheme:dark/)
    expect(ARTIFACT_STYLE).toContain(':root[data-theme="light"]')
  })

  it('lets Phosphor’s own theme beat the OS in both directions', () => {
    // The media query is guarded, so a dark stamp survives an OS set to light;
    // the attribute rule comes later in the sheet, so it beats OS dark too.
    expect(ARTIFACT_STYLE).toContain('@media (prefers-color-scheme:light)')
    expect(ARTIFACT_STYLE).toContain(':root:not([data-theme="dark"])')
  })

  it('retains legacy series and ramp slots in both modes', () => {
    for (const token of ['--art-s1', '--art-s5', '--art-r1', '--art-r5']) {
      // Once in the dark block, once per light stamp (media query + attribute).
      expect(ARTIFACT_STYLE.split(`${token}:`).length - 1).toBe(3)
    }
  })

  it('mirrors the app neutrals and accent without depending on parent CSS', () => {
    const appCss = readFileSync(new URL('../../src/styles/index.css', import.meta.url), 'utf8')
    const pairs = {
      bg: 'bg',
      panel: 'bg-secondary',
      'panel-2': 'code-bg',
      line: 'border',
      'line-soft': 'border',
      ink: 'text',
      'ink-2': 'text-secondary',
      'ink-3': 'text-tertiary',
      accent: 'accent',
      'accent-dim': 'accent-soft',
    }
    for (const [artifact, app] of Object.entries(pairs)) {
      const values = [...appCss.matchAll(new RegExp(`--px-${app}:\\s*(#[a-f0-9]+)`, 'g'))]
      expect(values).toHaveLength(2)
      const mirrored = [
        ...ARTIFACT_STYLE.matchAll(new RegExp(`--art-${artifact}:(#[a-f0-9]+)`, 'g')),
      ]
      expect(mirrored.map((match) => match[1])).toEqual([
        values[1]![1],
        values[0]![1],
        values[0]![1],
      ])
    }
    expect(ARTIFACT_STYLE).not.toContain('var(--px-')
  })

  it('gives HTML the viewport and makes a padded reading column opt-in', () => {
    const body = ARTIFACT_STYLE.match(/\nbody\{([^}]+)\}/)![1]!
    expect(body).toContain('margin:0; padding:0; min-height:100%')
    expect(body).not.toContain('max-width')
    expect(ARTIFACT_STYLE).toContain(
      '.art-document{max-width:76ch;margin:0 auto;padding:clamp(1rem,3vw,1.5rem)}',
    )
  })

  it('does not turn a prototype sidebar named rail into a legacy step grid', () => {
    expect(ARTIFACT_STYLE).not.toContain('.rail{')
    expect(ARTIFACT_STYLE).toContain('.rail:has(>.node>.gut){display:grid')
  })

  it('never lets a table demand more width than the panel has', () => {
    // A flat `min-width:30rem` put the whole page into a horizontal scroll in
    // the artifact panel, which is routinely narrower than that.
    expect(ARTIFACT_STYLE).toContain('min-width:min(100%,30rem)')
    expect(ARTIFACT_STYLE).not.toMatch(/min-width:\d+rem/)
    expect(ARTIFACT_STYLE).toContain('overflow-wrap:anywhere')
  })

  it('engages a row grid only for rows built from its cells', () => {
    // A .ledger/.steps/.rail row of free prose has one grid item per inline
    // child, so an unguarded fixed track sliced sentences into word-wide
    // columns. Every column track in those primitives must be :has()-guarded.
    for (const rule of ARTIFACT_STYLE.split('\n')) {
      if (!/^\.(ledger|steps|rail)\b/.test(rule)) continue
      if (!rule.includes('grid-template-columns')) continue
      expect(rule).toContain(':has(')
    }
    expect(ARTIFACT_STYLE).toContain('.ledger .row:has(>.idx,>.lab,>.bar,>.val)')
    expect(ARTIFACT_STYLE).toContain('.steps .s:has(>.n)')
  })

  it('loads no font over the network — the CSP allows none', () => {
    expect(ARTIFACT_STYLE).not.toContain('@import')
    expect(ARTIFACT_STYLE).not.toContain('@font-face')
    expect(ARTIFACT_STYLE).not.toMatch(/https?:/)
  })

  it('says nothing about printing — that is the print sheet’s job', () => {
    // Keeping the two apart is what lets the print rules be appended LAST
    // without also moving the look rules out from under the model's override.
    expect(ARTIFACT_STYLE).not.toContain('@media print')
  })
})

describe('the print stylesheet', () => {
  it('reaches only the printed document', () => {
    // Every rule lives inside the one @media print block, so staging with
    // `print` cannot change how anything looks on screen.
    expect(ARTIFACT_PRINT_STYLE.startsWith('@media print{')).toBe(true)
    expect(ARTIFACT_PRINT_STYLE.endsWith('}')).toBe(true)
    expect(ARTIFACT_PRINT_STYLE.match(/@media/g)).toHaveLength(1)
  })

  it('keeps each house primitive whole across a page break', () => {
    // The reason a Letter page is survivable at all: without these, Chromium
    // puts a break wherever the flow lands, including through a KPI strip.
    for (const primitive of [
      '.kpis',
      '.panelbox',
      '.callout',
      '.verdict',
      '.rail .node',
      '.ledger .row',
      '.steps .s',
      'pre',
      'svg',
      'table tr',
    ]) {
      expect(ARTIFACT_PRINT_STYLE).toContain(primitive)
    }
    expect(ARTIFACT_PRINT_STYLE).toContain('break-inside:avoid')
  })

  it('never leaves a heading stranded at the foot of a page', () => {
    expect(ARTIFACT_PRINT_STYLE).toMatch(/h1,h2,h3,h4\{break-after:avoid-page/)
    expect(ARTIFACT_PRINT_STYLE).toContain('orphans:2')
    expect(ARTIFACT_PRINT_STYLE).toContain('widows:2')
  })

  it('repeats a long table’s header on each page it spans', () => {
    expect(ARTIFACT_PRINT_STYLE).toContain('thead{display:table-header-group}')
    expect(ARTIFACT_PRINT_STYLE).toContain('table{display:table;width:100%;overflow:visible}')
  })

  it('wraps what scrolled on screen, because paper cannot scroll', () => {
    // A .scroll wrapper or an overflowing <pre> would otherwise print clipped,
    // and the clipped part is simply absent from the PDF.
    expect(ARTIFACT_PRINT_STYLE).toContain('.scroll{overflow:visible}')
    expect(ARTIFACT_PRINT_STYLE).toContain('white-space:pre-wrap')
  })

  it('leaves paper geometry to artifact-pdf.ts', () => {
    // One home for page size and margins. An @page rule here would be a second
    // one, and they would drift.
    expect(ARTIFACT_PRINT_STYLE).not.toContain('@page')
  })

  it('drops the screen gutter, which the page margins now provide', () => {
    expect(ARTIFACT_PRINT_STYLE).toContain(
      'html,body{margin:0;padding:0;max-width:none;height:auto;min-height:0}',
    )
    expect(ARTIFACT_PRINT_STYLE).toContain('.wrap{max-width:none')
    expect(ARTIFACT_PRINT_STYLE).toContain('.art-document{max-width:none;margin:0;padding:0}')
  })
})

describe('buildArtifactDocument — the print variant', () => {
  it('is absent unless asked for, so a preview document is unchanged', () => {
    expect(buildArtifactDocument('<p>hi</p>', 'dark')).not.toContain('@media print')
    expect(buildArtifactDocument('<p>hi</p>', 'dark', {})).toBe(
      buildArtifactDocument('<p>hi</p>', 'dark'),
    )
  })

  it('lands after the model’s own styles, so pagination is not overridable', () => {
    // The house sheet is a floor the model may override; the print rules are
    // not, or a model writing body{padding:2rem} doubles every page gutter.
    const doc = buildArtifactDocument('<style>body{padding:2rem}</style><p>hi</p>', 'dark', {
      print: true,
    })
    expect(doc.indexOf('body{padding:2rem}')).toBeLessThan(doc.indexOf('@media print'))
  })

  it('still lands last in a document the model wrote in full', () => {
    const full =
      '<!doctype html><html><head><style>h1{color:red}</style></head>' +
      '<body><style>body{padding:9rem}</style><p>hi</p></body></html>'
    const doc = buildArtifactDocument(full, 'dark', { print: true })
    expect(doc.indexOf('body{padding:9rem}')).toBeLessThan(doc.indexOf('@media print'))
    expect(doc.indexOf('@media print')).toBeLessThan(doc.indexOf('</body>'))
    expect(doc.match(/<body/gi)).toHaveLength(1)
  })

  it('appends to a full document that never closed its body', () => {
    // </body> is optional in HTML and model-authored documents routinely omit
    // it; a style after </html> still parses into the body.
    const doc = buildArtifactDocument('<html><body><p>hi</p>', 'dark', { print: true })
    expect(doc).toContain('@media print')
    expect(doc.indexOf('<p>hi</p>')).toBeLessThan(doc.indexOf('@media print'))
  })
})

describe('the print sheet’s page ground', () => {
  it('does not try to paint the page margins', () => {
    // Measured on Electron 43 across all four combinations (background on
    // body / on html, color-scheme dark / absent): a printToPDF margin is
    // never painted with the document background. A rule here claiming to fix
    // that would be a comment that lies, so there isn't one.
    expect(ARTIFACT_PRINT_STYLE).not.toContain('html{background')
  })
})
