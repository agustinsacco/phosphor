import { expect, test } from '@playwright/test'

const routes = [
  '/',
  '/guides/',
  '/guides/claude-code/',
  '/guides/extensions/',
  '/guides/connectors/',
]

for (const path of routes) {
  test(`${path}: readable, real assets, correct metadata, no client runtime`, async ({
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
    const response = await page.goto(path)
    expect(response?.ok()).toBe(true)
    await expect(page).toHaveTitle(/Phosphor/)
    await expect(page.locator('h1')).toHaveCount(1)
    await expect(page.locator('h1')).toBeVisible()
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      `https://phosphor.saccolabs.com${path}`,
    )
    await expect(page.locator('meta[name="description"]')).toHaveAttribute('content', /\S{10}/)
    await expect(page.locator('script, astro-island')).toHaveCount(0)
    await expect(page.locator('a[href="#"], a[href=""]')).toHaveCount(0)

    for (const summary of await page.locator('details summary').all()) await summary.click()
    for (const image of await page.locator('img').all()) {
      if (!(await image.isVisible())) continue
      await image.scrollIntoViewIfNeeded()
      await expect
        .poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
        .toBe(true)
    }
    for (const href of await page
      .locator('a.capture-link')
      .evaluateAll((links) => [
        ...new Set(links.map((link) => (link as HTMLAnchorElement).href)),
      ])) {
      expect((await request.get(href)).ok(), href).toBe(true)
    }
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true)
    expect(errors).toEqual([])
    for (const summary of await page.locator('details summary').all()) await summary.click()
    await page.evaluate(() => scrollTo({ top: 0, behavior: 'instant' }))
    await page.screenshot({
      path: testInfo.outputPath('page.png'),
      fullPage: true,
      animations: 'disabled',
      style: '.site-header { position: static; } .skip-link { visibility: hidden; }',
    })
  })
}

test('all local links resolve, including cross-page fragments and full-size captures', async ({
  page,
  request,
}) => {
  const destinations = new Set<string>()
  for (const path of routes) {
    await page.goto(path)
    for (const url of await page
      .locator('a[href]')
      .evaluateAll((links) =>
        links
          .map((link) => (link as HTMLAnchorElement).href)
          .filter((url) => new URL(url).origin === location.origin),
      ))
      destinations.add(url)
  }
  const bodies = new Map<string, string>()
  for (const href of destinations) {
    const url = new URL(href)
    const fragment = decodeURIComponent(url.hash.slice(1))
    url.hash = ''
    if (!bodies.has(url.href)) {
      const response = await request.get(url.href)
      expect(response.ok(), href).toBe(true)
      bodies.set(
        url.href,
        response.headers()['content-type']?.includes('text/html') ? await response.text() : '',
      )
    }
    if (fragment) {
      const found = await page.evaluate(
        ({ html, fragment }) =>
          Boolean(new DOMParser().parseFromString(html, 'text/html').getElementById(fragment)),
        { html: bodies.get(url.href)!, fragment },
      )
      expect(found, href).toBe(true)
    }
  }
})

test('landing leads with lanes, then chat, then the IDE layout without disclosures', async ({
  page,
}) => {
  await page.goto('/')
  const captures = page.locator('main .capture:visible')
  for (const [index, asset] of ['home', 'chat', 'ide-flex'].entries()) {
    const capture = captures.nth(index)
    await expect(capture).toBeVisible()
    await expect(capture.locator('.capture-link')).toHaveAttribute(
      'href',
      new RegExp(`/${asset}\\.[^/]+\\.(webp|png)$`),
    )
    await expect(capture.locator('figcaption')).toContainText('Real session')
  }
  await expect(page.locator('.hero-proof img')).toHaveAttribute('loading', 'eager')
  await expect(page.locator('.workflow-chat img')).toHaveAttribute('loading', 'lazy')
  await expect(page.locator('#surface > .capture img')).toHaveAttribute('loading', 'lazy')

  // A crop tuned for the old diff hero must not cut off the dashboard.
  const hero = page.locator('.hero-proof .capture-link')
  const image = hero.locator('img')
  await image.scrollIntoViewIfNeeded()
  await expect
    .poll(() => image.evaluate((img: HTMLImageElement) => img.complete && img.naturalWidth > 0))
    .toBe(true)
  const frame = (await hero.boundingBox())!
  const rendered = (await image.boundingBox())!
  expect(Math.abs(frame.width - rendered.width - 2)).toBeLessThan(1)
  expect(Math.abs(frame.height - rendered.height - 2)).toBeLessThan(1)
})

test('actual layouts use native controls and keyboard navigation', async ({ page }) => {
  await page.goto('/')
  await expect(page.locator('h1')).toHaveText('Parallel coding. Without losing the thread.')
  await expect(page.locator('.package-card')).toHaveCount(5)
  await expect(page.locator('.connector-grid > a')).toHaveCount(8)
  await page.locator('#surface summary').click()
  for (const id of ['left', 'full', 'right']) {
    await page.locator(`label[for="layout-${id}"]`).click()
    await expect(page.locator(`#layout-${id}`)).toBeChecked()
    await expect(page.locator(`#view-${id}`)).toBeVisible()
    await expect(page.locator('.surface-view:visible')).toHaveCount(1)
  }
  await page.locator('#layout-right').focus()
  await page.keyboard.press('ArrowRight')
  await expect(page.locator('#layout-left')).toBeChecked()
  await expect(page.locator('label[for="layout-left"]')).toHaveCSS('outline-style', 'solid')
  await expect(page.getByText(/layout study|Claude Desktop–like|Codex app–like/)).toHaveCount(0)
})

test('guide handoffs, privacy labels, skip link, and reduced motion', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await page.keyboard.press('Tab')
  await expect(page.locator('.skip-link')).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page).toHaveURL(/#main$/)
  await expect(page.locator('html')).toHaveCSS('scroll-behavior', 'auto')
  await page.getByRole('link', { name: 'Set up Claude and multiple accounts →' }).click()
  await expect(page).toHaveURL(/\/guides\/claude-code\/$/)
  await expect(page.locator('.notice').first()).toContainText(
    'No personal accounts or credentials were loaded',
  )
  await expect(page.locator('.guide-content .capture')).toHaveCount(3)
  await expect(page.locator('#install ol')).toHaveCSS('list-style-type', 'decimal')
  await expect(page.locator('#routing ul')).toHaveCSS('list-style-type', 'disc')
  for (const capture of await page.locator('.guide-content .capture').all()) {
    await expect(capture.locator('figcaption')).toContainText('Settings demo')
    await expect(capture.locator('a')).toHaveAttribute('href', /guide-.*\.webp$/)
  }
  await page
    .getByRole('navigation', { name: 'Setup guides' })
    .getByRole('link', { name: 'MCP connectors' })
    .click()
  await expect(page.locator('#slack')).toContainText('PKCE')
  await expect(page.locator('#adapter')).toContainText('pi install npm:pi-mcp-adapter')
})

test('all pages support narrow screens and enlarged text', async ({ page }) => {
  for (const path of routes) {
    for (const width of [320, 768, 1920]) {
      await page.setViewportSize({ width, height: 900 })
      await page.goto(path)
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `${path} at ${width}`,
      ).toBe(true)
    }
    await page.setViewportSize({ width: 390, height: 844 })
    await page.locator('html').evaluate((html) => {
      html.style.fontSize = '200%'
    })
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
      `${path} at 200%`,
    ).toBe(true)
  }
})
