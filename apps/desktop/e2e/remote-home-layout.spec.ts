import { test, expect } from '@playwright/test'
import { remoteHostFixture, REMOTE_TEST_TIMEOUT } from './fixtures/remote-host'
import { selectMachine } from './fixtures/remote-ui'

test('remote home contains a long lane list and keeps creation reachable in a short Desktop window', async ({
  browserName: _browserName,
}, info) => {
  test.setTimeout(REMOTE_TEST_TIMEOUT)
  const h = await remoteHostFixture()
  try {
    for (let i = 0; i < 12; i++) await h.createLane(1, undefined, `Synthetic overflow lane ${i}`)
    await h.signIn()
    await selectMachine(h, 'bee1')
    await h.page.getByRole('button', { name: 'New', exact: true }).click()
    await h.app.evaluate(({ BrowserWindow }) =>
      BrowserWindow.getAllWindows()[0]!.setContentSize(1024, 540),
    )
    const home = h.page.locator('.remote-workspace-page')
    await expect(home).toBeVisible()
    await expect(h.page.getByRole('button', { name: 'Model', exact: true })).toBeVisible()
    const bounds = await home.evaluate((element) => ({
      top: element.getBoundingClientRect().top,
      bottom: element.getBoundingClientRect().bottom,
      parentBottom: element.parentElement!.getBoundingClientRect().bottom,
    }))
    expect(bounds.bottom).toBeLessThanOrEqual(bounds.parentBottom + 1)
    await expect(h.page.getByRole('button', { name: 'Start lane', exact: true })).toBeInViewport()
    const list = home.locator('.remote-workspace-intro')
    expect(await list.evaluate((element) => element.scrollHeight > element.clientHeight)).toBe(true)
    await h.page.screenshot({ path: info.outputPath('remote-home-short-dark.png') })
  } finally {
    await h.close()
  }
})
