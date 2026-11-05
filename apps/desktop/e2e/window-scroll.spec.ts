import { test, expect, type Page } from '@playwright/test'
import { launch, shutdown, openWorkspace } from './fixtures/local-app'

const shift = (page: Page) =>
  page.evaluate(() => ({
    viewport: document.scrollingElement?.scrollTop ?? 0,
    body: document.body.scrollTop,
    topBar: Math.round(document.querySelector('header')!.getBoundingClientRect().top),
  }))

// The window never scrolls. With only `overflow: hidden`, anything hanging below
// the window (a popup before it is placed, a menu, a portal) let focus scroll the
// viewport: the whole app moved up, the top bar went off-screen and a blank strip
// stayed below until the window was reloaded.
test('focus below the window never shifts the app, wherever the overflow lives', async () => {
  const h = await launch()
  try {
    await openWorkspace(h.page)
    await h.page.getByPlaceholder('Describe a task or ask a question').fill('hello')
    await h.page.getByRole('button', { name: /Start lane/i }).click()
    await expect(h.page.locator('[data-composer-input]')).toBeVisible()
    for (const host of ['main', 'body']) {
      await h.page.evaluate((host) => {
        const box = document.createElement('div')
        box.dataset.probe = host
        box.style.cssText = 'position:absolute;left:40px;top:calc(100% + 10px);height:430px'
        box.innerHTML = '<button style="margin-top:400px">below the window</button>'
        document.querySelector(host)!.append(box)
        box.querySelector('button')!.focus()
        box.querySelector('button')!.scrollIntoView()
      }, host)
      expect(await shift(h.page), host).toEqual({ viewport: 0, body: 0, topBar: 0 })
      await h.page.evaluate(
        (host) => document.querySelector(`[data-probe="${host}"]`)?.remove(),
        host,
      )
    }
  } finally {
    await shutdown(h)
  }
})
