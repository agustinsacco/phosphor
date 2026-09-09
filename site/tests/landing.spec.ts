import { expect, test } from '@playwright/test'

// These checks run against the built page, not Astro's JS-injecting dev server.
// evaluate() below only observes DOM state; none of the interactions rely on it.
test('complete page, real assets, no client runtime or browser errors', async ({
  page,
  request,
}, testInfo) => {
  const errors: string[] = []
  page.on('pageerror', (error) => errors.push(error.message))
  page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text())
  })
  page.on('requestfailed', (request) =>
    errors.push(`${request.url()}: ${request.failure()?.errorText}`),
  )
  page.on('response', (response) => {
    if (response.status() >= 400) errors.push(`${response.status()}: ${response.url()}`)
  })
  await page.goto('/')
  await expect(page).toHaveTitle('Phosphor — Same agent. Your surface.')
  await expect(page.locator('h1')).toHaveCount(1)
  await expect(page.locator('script')).toHaveCount(0)
  await expect(page.locator('astro-island')).toHaveCount(0)
  await expect(page.locator('main > section')).toHaveCount(11)

  for (const section of await page.locator('main > section').all()) {
    await section.scrollIntoViewIfNeeded()
    await expect(section.locator('h1, h2').first()).toBeVisible()
  }
  for (const summary of await page.locator('details summary').all()) await summary.click()
  for (const image of await page.locator('img').all()) {
    if (!(await image.isVisible())) continue
    await image.scrollIntoViewIfNeeded()
    await expect
      .poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
      .toBe(true)
  }
  const assetURLs = await page
    .locator('a.capture-link, a.ide-original')
    .evaluateAll((links) => [...new Set(links.map((link) => (link as HTMLAnchorElement).href))])
  for (const url of assetURLs) expect((await request.get(url)).ok(), url).toBe(true)
  for (const url of [
    '/favicon.svg',
    '/og.png',
    '/fonts/InterVariable.woff2',
    '/fonts/JetBrainsMono.ttf',
  ]) {
    expect((await request.get(url)).ok(), url).toBe(true)
  }
  const brokenAnchors = await page
    .locator('a[href^="#"]')
    .evaluateAll((links) =>
      links
        .map((link) => link.getAttribute('href')!)
        .filter((href) => href.length > 1 && !document.getElementById(href.slice(1))),
    )
  expect(brokenAnchors).toEqual([])
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
  expect(errors).toEqual([])

  // Close disclosures again; screenshots represent the default reading surface.
  for (const summary of await page.locator('details summary').all()) await summary.click()
  await page.evaluate(() => window.scrollTo({ top: 0, behavior: 'instant' }))
  await page.screenshot({
    path: testInfo.outputPath('landing.png'),
    fullPage: true,
    animations: 'disabled',
    style:
      '.site-header { position: static; } .skip-link { visibility: hidden; } img { content-visibility: visible !important; }',
  })
})

test('layout studies and appearance work with native controls', async ({ page }, testInfo) => {
  await page.goto('/')
  for (const id of ['claude', 'codex', 'ide']) {
    await page.locator(`label[for="layout-${id}"]`).click()
    await expect(page.locator(`#layout-${id}`)).toBeChecked()
    await expect(page.locator(`#view-${id}`)).toBeVisible()
    await expect(page.locator('.surface-view:visible')).toHaveCount(1)
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    await page.locator('.surface-lab').screenshot({
      path: testInfo.outputPath(`surface-${id}.png`),
      animations: 'disabled',
      style: '.site-header, .skip-link { visibility: hidden; }',
    })
  }
  await page.locator('label[for="theme-light"]').click()
  await expect(page.locator('#theme-light')).toBeChecked()
  await expect(page.locator('.theme-light-capture')).toBeVisible()
  await expect(page.locator('.theme-dark-capture')).toBeHidden()
  await page.locator('label[for="theme-dark"]').click()
  await expect(page.locator('.theme-dark-capture')).toBeVisible()
})

test('diagram animates, pauses without JS, and uses the supplied IDE capture', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'no-preference' })
  await page.goto('/')
  await expect(page.locator('.wire-window').first()).toHaveCSS('animation-name', 'surface-cycle')
  await expect(page.locator('.signal-path span')).toHaveCSS('animation-iteration-count', 'infinite')
  await page.locator('label[for="diagram-paused"]').click()
  await expect(page.locator('#diagram-paused')).toBeChecked()
  await expect(page.locator('.wire-window').first()).toHaveCSS('animation-play-state', 'paused')
  await expect(page.locator('.provider-path i').last()).toHaveCSS('animation-play-state', 'paused')
  await page.locator('label[for="diagram-paused"]').click()
  await expect(page.locator('.wire-window').first()).toHaveCSS('animation-play-state', 'running')
  await expect(page.locator('.claude-route')).toContainText('Claude Code')
  await expect(page.locator('.claude-route')).toContainText('via pi-claude-cli')
  await expect(page.locator('.ide-original')).toHaveAttribute('href', /ide-flex.*\.png$/)
  await expect(page.locator('.ide-original img')).toHaveAttribute('width', '6012')
  await expect(page.locator('.ide-original img')).toHaveAttribute('height', '3322')
  await expect(page.locator('.ide-original img')).toHaveAttribute('alt', /Claude Opus 5.*35%/)
  await expect(page.locator('.asset-note')).toHaveCount(0)
})

test('keyboard navigation and reduced motion remain usable', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await page.keyboard.press('Tab')
  await expect(page.locator('.skip-link')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/#main$/)
  // Focus enters the native group once, and arrow keys move the selection.
  await page.locator('#layout-ide').focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.locator('#layout-claude')).toBeChecked()
  await expect(page.locator('#view-claude')).toBeVisible()
  await expect(page.locator('label[for="layout-claude"]')).toHaveCSS('outline-style', 'solid')
  await page.keyboard.press('ArrowRight')
  await expect(page.locator('#layout-codex')).toBeChecked()
  await page.locator('#theme-dark').focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.locator('#theme-light')).toBeChecked()
  expect(
    await page.evaluate(
      () =>
        document.getAnimations().filter((animation) => animation.playState === 'running').length,
    ),
  ).toBe(0)
  await expect(page.locator('html')).toHaveCSS('scroll-behavior', 'auto')
})

test('narrow viewports and enlarged text do not overflow the page', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  for (const width of [320, 375, 768, 1024, 1920]) {
    await page.setViewportSize({ width, height: 900 })
    await page.goto('/')
    await page.locator('label[for="layout-codex"]').click()
    await page.locator('#install').scrollIntoViewIfNeeded()
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      `width ${width}`,
    ).toBe(true)
  }
  await page.setViewportSize({ width: 390, height: 844 })
  await page.locator('html').evaluate((html) => {
    html.style.fontSize = '200%'
  })
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
})
