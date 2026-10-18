import { writeFile } from 'node:fs/promises'
import { Buffer } from 'node:buffer'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'
import { redactLivePage } from './live-redaction.mjs'

function nudge(app, dy) {
  return app.evaluate(({ BrowserWindow }, dy) => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
    if (!win) return
    if (!win.isVisible()) win.show()
    win.moveTop()
    win.focus()
    const b = win.getBounds()
    win.setBounds({ ...b, height: b.height + dy })
  }, dy)
}

export function createLiveCapture({ app, page, outDir, maxWidth, wanted, redactions }) {
  const shots = []
  const shot = async (name) => {
    if (!wanted(name)) return
    const path = join(outDir, `${name}.png`)
    await nudge(app, -1)
    await page.waitForTimeout(200)
    await nudge(app, 1)
    await page.waitForTimeout(400)
    // One pass over the page, then an observer that keeps redacting: live
    // surfaces (the context meter's MCP chips) re-render from status pushes,
    // and a one-off pass lost that race between the pass and the capture.
    // Observer callbacks run as microtasks, so they land before the next paint.
    await page.evaluate(redactLivePage, redactions)
    const dataUrl = await app.evaluate(async ({ BrowserWindow }) => {
      const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
      return win.capturePage().then((image) => image.toDataURL())
    })
    await writeFile(path, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'))
    if (maxWidth > 0) {
      try {
        execFileSync('sips', ['-Z', String(maxWidth), path, '--out', path], { stdio: 'ignore' })
      } catch {
        // no sips (non-macOS): keep the device-scale original
      }
    }
    shots.push(name)
    console.log(`  ✓ ${name}.png (${Math.round(statSync(path).size / 1024)} KB)`)
  }

  return { shot, shots }
}
