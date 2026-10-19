import { test, expect } from './fixture'

/** Text-only magnification stress, not a claim of testing an OS accessibility setting. */
test('shared pages wrap at doubled text sizes and the composer follows a reduced viewport', async ({
  stack,
  page,
}, info) => {
  await page.setViewportSize({ width: 412, height: 924 })
  await page.goto(stack.origin)
  await page.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Model', exact: true })).toBeVisible()
  for (const route of ['settings', 'machines']) {
    await page.goto(`${stack.origin}/pages/${route}`)
    await expect(page.locator('.page-shell h1')).toHaveCount(1)
    await page.evaluate(() => {
      const fonts = [...document.querySelectorAll<HTMLElement>('.page-shell *')].map((element) => ({
        element,
        size: parseFloat(getComputedStyle(element).fontSize),
      }))
      for (const { element, size } of fonts) element.style.fontSize = `${size * 2}px`
    })
    const widths = await page
      .locator('.page-body-content, .page-shell-header')
      .evaluateAll((elements) =>
        elements.map((element) => ({ width: element.clientWidth, scroll: element.scrollWidth })),
      )
    expect(
      widths.every((value) => value.scroll <= value.width + 1),
      JSON.stringify(widths),
    ).toBe(true)
    await page.screenshot({ path: info.outputPath(`${route}-doubled-text.png`), fullPage: true })
  }
  await page.goto(`${stack.origin}/new/${stack.hostId}`)
  await expect(page.getByRole('button', { name: 'Model', exact: true })).toBeVisible()
  await page.setViewportSize({ width: 412, height: 480 })
  await page.getByRole('textbox', { name: 'Chat message' }).focus()
  await expect
    .poll(() => page.locator('.browser-shell').evaluate((element) => element.clientHeight))
    .toBe(480)
  await expect(page.getByRole('button', { name: 'Start lane', exact: true })).toBeInViewport()
  await page.screenshot({ path: info.outputPath('reduced-keyboard-viewport.png'), fullPage: true })
})
