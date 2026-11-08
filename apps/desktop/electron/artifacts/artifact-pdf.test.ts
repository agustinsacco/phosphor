import { describe, expect, it, vi } from 'vitest'
import { tmpdir } from 'node:os'

// electron is not loadable under vitest, and the print itself is Chromium's —
// what is testable here is where the file lands and what it is called.
vi.mock('electron', () => ({
  app: { getPath: vi.fn(() => tmpdir()) },
  BrowserWindow: vi.fn(),
  protocol: { registerSchemesAsPrivileged: vi.fn(), handle: vi.fn() },
}))

const { pdfFileName } = await import('./artifact-pdf')

describe('pdfFileName', () => {
  it('keeps a readable name rather than a run of dashes', () => {
    // The first version replaced every non-alphanumeric with '-', so an em
    // dash in a title produced `NFI-----What-shipped.pdf`.
    expect(pdfFileName('NFI Knowledge Hub — What shipped')).toBe(
      'NFI Knowledge Hub — What shipped.pdf',
    )
    expect(pdfFileName('Q3 - review -- draft')).toBe('Q3 review draft.pdf')
  })

  it('strips path separators and other filesystem-hostile characters', () => {
    expect(pdfFileName('reports/2026: q3 "final"?')).toBe('reports 2026 q3 final.pdf')
  })

  it('falls back when a title has nothing usable left', () => {
    expect(pdfFileName('///')).toBe('artifact.pdf')
    expect(pdfFileName('')).toBe('artifact.pdf')
  })

  it('caps the length', () => {
    expect(pdfFileName('x'.repeat(200))).toBe(`${'x'.repeat(60)}.pdf`)
  })
})
