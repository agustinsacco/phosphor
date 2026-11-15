import { URL } from 'node:url'

import { chromium } from '@playwright/test'
import { base, root, shot } from './capture-harness.mjs'

export async function captureMobile() {
  const browser = await chromium.launch()
  try {
    const page = await browser.newPage({
      viewport: { width: 430, height: 932 },
      deviceScaleFactor: 2,
      locale: 'en-US',
      timezoneId: 'UTC',
      reducedMotion: 'reduce',
    })
    await page.route('**/*', (route) => {
      const url = new URL(route.request().url())
      if (url.origin !== new URL(base).origin) return route.abort()
      if (route.request().isNavigationRequest())
        return route.fulfill({
          contentType: 'text/html',
          body: `<!doctype html><html><head><meta name="viewport" content="width=device-width, initial-scale=1" /></head><body><script type="module">import RefreshRuntime from "/@react-refresh";RefreshRuntime.injectIntoGlobalHook(window);window.$RefreshReg$=()=>{};window.$RefreshSig$=()=>type=>type;window.__vite_plugin_react_preamble_installed__=true;</script><div id="root"></div><script type="module" src="/@fs${root}apps/site/scripts/fixtures/mobile-entry.mjs"></script></body></html>`,
        })
      return route.continue()
    })
    page.on('pageerror', (error) => console.log(error.message))
    await page.goto(base)
    await page.getByTestId('compact-shell').waitFor({ timeout: 30000 })
    await page.waitForTimeout(2500)
    console.log(await page.locator('body').innerText())
    await shot(page, 'mobile')
    await page.setViewportSize({ width: 1600, height: 1000 })
    await page.waitForTimeout(1000)
    await shot(page, 'pwa-wide')
  } finally {
    await browser.close()
  }
}
if (process.argv[1]?.endsWith('mobile-shots.mjs')) await captureMobile()
