import { test } from '@playwright/test'
import { launch, shutdown } from './fixtures/local-app'

// Throwaway probe: how long does each fresh Electron launch take to produce
// its first animation frame?
test.setTimeout(600_000)

const label = process.env.PROBE_LABEL ?? '?'

test('frame probe', async () => {
  for (let i = 0; i < 4; i++) {
    const t0 = Date.now()
    const h = await launch()
    const tWindow = Date.now() - t0
    const firstFrame = async () => {
      const s = Date.now()
      while (Date.now() - s < 90_000) {
        const ok = await h.page.evaluate(
          () =>
            new Promise<boolean>((r) => {
              const t = setTimeout(() => r(false), 1000)
              requestAnimationFrame(() => {
                clearTimeout(t)
                r(true)
              })
            }),
        )
        if (ok) return Date.now() - s
      }
      return -1
    }
    const frame = await firstFrame()
    const state = await h.page.evaluate(() => ({
      vis: document.visibilityState,
      focus: document.hasFocus(),
      w: innerWidth,
      h: innerHeight,
      url: location.pathname,
    }))
    const main = await h.app.evaluate(({ app, BrowserWindow }) => ({
      gpu: app.getGPUFeatureStatus(),
      windows: BrowserWindow.getAllWindows().map((w) => ({
        visible: w.isVisible(),
        focused: w.isFocused(),
        bounds: w.getBounds(),
        url: w.webContents.getURL().slice(-40),
      })),
    }))
    const frame2 = await firstFrame()
    console.log(
      `PROBE ${label} launch=${i} window=${tWindow}ms firstFrame=${frame}ms secondCheck=${frame2}ms ${JSON.stringify(state)} ${JSON.stringify(main)}`,
    )
    await shutdown(h)
  }
})
