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
 *
 * ## Why this prints Letter pages instead of one page as tall as the artifact
 *
 * The version this replaces measured the document and made the page that tall
 * — a real export came out 8.5 x 39 INCHES. That was chosen to dodge
 * pagination (nothing can break badly if there are no breaks), and it cost
 * more than it saved:
 *
 * - It is not a document. No reader paginates it, no printer puts it on paper
 *   without scaling it to nothing, and a thumbnail is a 1-inch-wide ribbon.
 * - It did not even avoid the second page. The measurement happened in a
 *   window; the print happened in Chromium's print layout, which is not the
 *   same layout. A few pixels of disagreement put the last two lines on a
 *   SECOND 39-inch page, 97% of it empty — the exact artifact that prompted
 *   this rewrite. A one-page strategy has one break point and is fragile at
 *   precisely that point; there was 0.5in of slack and the drift exceeded it.
 * - The failure got worse as documents got longer, which is backwards.
 *
 * So the page is Letter, always, and the breaks are placed by rules rather
 * than dodged: `ARTIFACT_PRINT_STYLE` in `artifact-skeleton.ts` keeps a KPI
 * strip, a callout, a table row or a heading-plus-its-section from being split
 * across one. That also deletes the measure step, and with it the entire class
 * of bug where the measuring viewport and the printing viewport disagree.
 */

/** CSS pixels per inch, as Chromium lays out for print. */
const CSS_DPI = 96

/** US Letter. */
const PAGE_WIDTH_INCHES = 8.5
const PAGE_HEIGHT_INCHES = 11

/**
 * The gutter on every page, in inches.
 *
 * Set here rather than as an `@page` rule so paper geometry has one home, and
 * so it cannot be overridden by a model that wrote its own `@page`.
 *
 * A margin is NOT painted with the artifact's ground — measured, not assumed;
 * see the note in `ARTIFACT_PRINT_STYLE`. So a dark artifact prints its ground
 * inside the margins with a faint frame around it. Zero margins would remove
 * the frame and cost more than it saves: a physical printer cannot reach the
 * sheet edge, so an edge-to-edge page comes out of one with its outermost
 * content missing.
 */
const PAGE_MARGIN_INCHES = 0.5

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

/**
 * Render an artifact to a PDF in the user's Downloads folder.
 *
 * Throws on failure — the renderer surfaces it as a toast, because a silent
 * rejection is indistinguishable from a button that does nothing (which is what
 * this looked like before: the handler could reject and the click handler had
 * no catch, no success path and no feedback of any kind).
 */
export async function exportArtifactPdf(request: ArtifactPdfRequest): Promise<{ savedTo: string }> {
  const url = stageArtifactHtml(request.html, request.theme, { print: true })

  const win = new BrowserWindow({
    show: false,
    // A Letter page at 96dpi. Nothing is measured here any more, so this only
    // has to be close: it decides what `vw`-sized type resolves to, and a
    // window shaped like the page is what makes `clamp(1.7rem,4.5vw,2.4rem)`
    // print at the size the page was designed for.
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

    const pdf = await win.webContents.printToPDF({
      printBackground: true,
      pageSize: { width: PAGE_WIDTH_INCHES, height: PAGE_HEIGHT_INCHES },
      margins: {
        marginType: 'custom',
        top: PAGE_MARGIN_INCHES,
        bottom: PAGE_MARGIN_INCHES,
        left: PAGE_MARGIN_INCHES,
        right: PAGE_MARGIN_INCHES,
      },
      // The size above is the authority. `true` would hand page geometry to
      // any `@page` rule a model happened to write, which is the one thing
      // model-authored CSS must not be able to decide here.
      preferCSSPageSize: false,
    })

    const savedTo = await uniqueDownloadPath(app.getPath('downloads'), pdfFileName(request.title))
    await writeFile(savedTo, pdf)
    return { savedTo }
  } finally {
    if (!win.isDestroyed()) win.destroy()
  }
}
