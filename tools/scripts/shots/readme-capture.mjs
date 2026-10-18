import { writeFile } from 'node:fs/promises'
import { Buffer } from 'node:buffer'
import { statSync } from 'node:fs'
import { join } from 'node:path'
import { execFileSync } from 'node:child_process'

/*
 * Panel and session switches cross-fade, keeping the outgoing layer mounted
 * until its transition ends. Capturing inside that window puts two states in
 * one frame, so every switch is followed by a settle. (Overriding transitions
 * away does NOT help: the outgoing layer unmounts on `transitionend`, so
 * killing the transition strands it there permanently.)
 */
export const settle = async (p, ms = 2400) => p.waitForTimeout(ms)

/*
 * A screenshot taken after a view switch can come back with the previous
 * view ghosted through the new one: Chromium repaints the damaged rectangle
 * only, and for a window nobody is looking at, the damage from swapping a
 * pane is not always enough to clear the layer underneath. Waiting does not
 * help — the stale pixels are stable. Resizing is what forces a full
 * repaint, so nudge the window by a pixel and back before grabbing.
 */
export const nudge = (app, dy) =>
  app.evaluate(({ BrowserWindow }, dy) => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
    if (!win) return
    if (!win.isVisible()) win.show()
    win.moveTop()
    win.focus()
    const b = win.getBounds()
    win.setBounds({ ...b, height: b.height + dy })
  }, dy)

/*
 * Grab through Electron's own capturePage rather than CDP: it rasterises the
 * window's current frame at the backing scale, so a switch that CDP renders
 * as two stacked layers (a ghost of the outgoing pane behind the incoming
 * one) comes out as one clean image. capturePage is at device pixels, so
 * downscale back to CSS size with sips when it is available (macOS).
 */
export async function captureShot({ app, page, outDir, maxWidth, only, shots }, name) {
  if (only.length > 0 && !only.includes(name)) return
  const path = join(outDir, `${name}.png`)
  await nudge(app, -1)
  await page.waitForTimeout(200)
  await nudge(app, 1)
  await page.waitForTimeout(400)
  const dataUrl = await app.evaluate(async ({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find((w) => !w.isDestroyed())
    return win.capturePage().then((image) => image.toDataURL())
  })
  await writeFile(path, Buffer.from(dataUrl.slice(dataUrl.indexOf(',') + 1), 'base64'))
  try {
    if (maxWidth > 0) {
      execFileSync('sips', ['-Z', String(maxWidth), path, '--out', path], { stdio: 'ignore' })
    }
  } catch {
    // no sips (non-macOS): keep the device-scale original
  }
  shots.push(name)
  console.log(`  ✓ ${name}.png (${Math.round(statSync(path).size / 1024)} KB)`)
}
