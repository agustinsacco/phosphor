import { app, BrowserWindow } from 'electron'
import { access, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { stageArtifactHtml } from './artifact-protocol'

/**
 * "Export preview to PDF" — printed from the SAME document the preview shows.
 *
 * The first version of this built its own document: a hand-copied subset of the
 * house stylesheet, plus `marked` and `mermaid` from a CDN, loaded over a
 * `data:` URL. Every part of that was a way to drift from what is on screen —
 * the copied sheet knew nothing of `.kpis`, `table.data`, `.ledger` or `.rail`,
 * so a typical artifact printed as unstyled prose, and the CDN scripts are
 * exactly what the artifact CSP exists to refuse (offline, they render nothing
 * at all). It also measured page height in a 1200px-wide window and then
 * printed 816px wide, so the tail of a long artifact fell off the bottom of the
 * single tall page.
 *
 * So this stages through `stageArtifactHtml` — the identical path the preview
 * iframe uses, house sheet and theme stamp included — and prints that. There is
 * one document builder, not two, and a fix to the sheet reaches the PDF for
 * free.
 */

/** CSS pixels per inch, as Chromium lays out for print. */
const CSS_DPI = 96

/** US Letter width. The print width the page is measured at, so the two agree. */
const PAGE_WIDTH_INCHES = 8.5

/** Letter height, used for the multi-page fallback. */
const PAGE_HEIGHT_INCHES = 11

/**
 * A single page taller than this becomes a multi-page Letter print instead.
 * Chromium accepts far taller, but a 30-foot page is not a document anyone can
 * open in a reader, and clipping the overflow (what the previous version did)
 * silently loses content.
 */
const MAX_SINGLE_PAGE_INCHES = 200

/** Bound on the load; a scripted artifact that never settles must not hang the call. */
const LOAD_TIMEOUT_MS = 10_000

export interface ArtifactPdfRequest {
  /** Model-authored markup, exactly as the preview receives it. */
  html: string
  title: string
  theme: 'light' | 'dark'
}

/**
 * A filename from an artifact title.
 *
 * A title is prose, and the download keeps reading like it: spaces and dashes
 * survive, only what a filesystem or a shell would choke on is dropped, and a
 * RUN of separators collapses to one. The version this replaces mapped every
 * non-alphanumeric to `-`, so an em dash arrived in Downloads as
 * `NFI-Knowledge-Hub---What-Shipped--What-s-in-Review.pdf`.
 */
export function pdfFileName(title: string): string {
  const cleaned = title
    .replace(/[\p{Cc}/\\?%*:|"<>]/gu, ' ')
    .replace(/[-\s]{2,}/g, ' ')
    .trim()
    .slice(0, 60)
    .trim()
  return `${cleaned || 'artifact'}.pdf`
}

/** `name.pdf`, `name (2).pdf`, … — an export never overwrites an earlier one. */
export async function uniqueDownloadPath(dir: string, fileName: string): Promise<string> {
  const stem = fileName.replace(/\.pdf$/i, '')
  for (let n = 1; n < 100; n++) {
    const candidate = join(dir, n === 1 ? `${stem}.pdf` : `${stem} (${n}).pdf`)
    try {
      await access(candidate)
    } catch {
      return candidate
    }
  }
  return join(dir, `${stem} (${Date.now()}).pdf`)
}

/** Resolve once the document has loaded, or reject with what went wrong. */
async function loadArtifact(win: BrowserWindow, url: string): Promise<void> {
  const failure = new Promise<never>((_resolve, reject) => {
    win.webContents.once('did-fail-load', (_event, code, description) => {
      reject(new Error(`Could not render the artifact (${description || code})`))
    })
  })
  const timeout = new Promise<never>((_resolve, reject) => {
    setTimeout(() => reject(new Error('Timed out rendering the artifact')), LOAD_TIMEOUT_MS)
  })
  await Promise.race([win.loadURL(url), failure, timeout])
}

/**
 * Give the document a beat to settle before measuring.
 *
 * `loadURL` resolves on `did-finish-load`, which is BEFORE webfonts have
 * swapped and before a scripted artifact has drawn. (The previous version
 * registered its `did-finish-load` listener after awaiting the load, so the
 * event had always already fired and every export paid a flat 3s timeout
 * instead.) Two frames plus `document.fonts.ready` is what actually correlates
 * with a stable layout; the guard keeps a broken script from hanging the call.
 */
async function settle(win: BrowserWindow): Promise<void> {
  try {
    await win.webContents.executeJavaScript(
      `new Promise((resolve) => {
         const done = () => requestAnimationFrame(() => requestAnimationFrame(() => resolve(true)))
         const fonts = document.fonts && document.fonts.ready ? document.fonts.ready : Promise.resolve()
         Promise.race([fonts, new Promise((r) => setTimeout(r, 2000))]).then(done)
       })`,
      true,
    )
  } catch {
    // Measurement still works on an un-settled document; better a slightly
    // early print than no PDF at all.
  }
}

/** Full document height in CSS pixels, measured at the print width. */
async function measureHeight(win: BrowserWindow): Promise<number> {
  try {
    const measured = await win.webContents.executeJavaScript(
      `Math.max(document.body ? document.body.scrollHeight : 0, document.documentElement.scrollHeight, document.body ? document.body.offsetHeight : 0)`,
      true,
    )
    const height = Number(measured)
    return Number.isFinite(height) && height > 0 ? height : PAGE_HEIGHT_INCHES * CSS_DPI
  } catch {
    return PAGE_HEIGHT_INCHES * CSS_DPI
  }
}

/**
 * Render an artifact to a PDF in the user's Downloads folder.
 *
 * Throws on failure — the renderer surfaces it as a toast, because a silent
 * rejection is indistinguishable from a button that does nothing (which is what
 * this looked like before: the handler could reject and the click handler had
 * no catch, no success path and no feedback of any kind).
 */
export async function exportArtifactPdf(request: ArtifactPdfRequest): Promise<{ savedTo: string }> {
  const url = stageArtifactHtml(request.html, request.theme)

  const win = new BrowserWindow({
    show: false,
    // Measured at the width it prints at. A wider window measures a shorter
    // page, and the difference is content missing from the bottom of the PDF.
    width: Math.round(PAGE_WIDTH_INCHES * CSS_DPI),
    height: Math.round(PAGE_HEIGHT_INCHES * CSS_DPI),
    webPreferences: {
      // Model-authored HTML runs here, same as in the preview iframe. It is
      // served with `default-src 'none'` so it has no network reach, and this
      // window has no preload, no Node and no navigation of its own.
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false,
      webSecurity: true,
      backgroundThrottling: false,
    },
  })
  win.webContents.setWindowOpenHandler(() => ({ action: 'deny' }))
  win.webContents.on('will-navigate', (event) => event.preventDefault())

  try {
    await loadArtifact(win, url)
    await settle(win)

    const heightPx = await measureHeight(win)
    // The margin-free page needs a little slack, or a final line that ends
    // flush with the measured height lands on a second, near-empty page.
    const singlePageInches = heightPx / CSS_DPI + 0.5
    const pageSize =
      singlePageInches <= MAX_SINGLE_PAGE_INCHES
        ? { width: PAGE_WIDTH_INCHES, height: Math.max(singlePageInches, PAGE_HEIGHT_INCHES) }
        : { width: PAGE_WIDTH_INCHES, height: PAGE_HEIGHT_INCHES }

    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      pageSize,
      margins: { marginType: 'none' },
      preferCSSPageSize: false,
    })

    const savedTo = await uniqueDownloadPath(app.getPath('downloads'), pdfFileName(request.title))
    await writeFile(savedTo, pdf)
    return { savedTo }
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}
