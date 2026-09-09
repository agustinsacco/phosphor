import { test, expect } from '@playwright/test'
import AxeBuilder from '@axe-core/playwright'

const routes = ['/', '/workbench', '/download', '/design']

for (const route of routes) {
  test(`${route} is readable, accessible, and internally linked`, async ({ page }) => {
    const errors: string[] = []
    page.on('pageerror', (error) => errors.push(error.message))
    const response = await page.goto(route)
    expect(response?.status()).toBe(200)
    await page.evaluate(() => document.fonts.ready)
    await expect(page.locator('h1')).toHaveCount(1)
    await expect(page.locator('h1')).toBeVisible()
    await expect(page.locator('link[rel="canonical"]')).toHaveAttribute(
      'href',
      `https://phosphor.saccolabs.com${route}`,
    )
    expect(await page.locator('meta[name="description"]').getAttribute('content')).toBeTruthy()

    // Trigger native lazy loading before checking image delivery and page geometry.
    for (const image of await page.locator('img:visible').all()) {
      await image.scrollIntoViewIfNeeded()
      await expect
        .poll(() =>
          image.evaluate((node: HTMLImageElement) => node.complete && node.naturalWidth > 0),
        )
        .toBe(true)
    }
    const links = await page
      .locator('a[href]')
      .evaluateAll((anchors) => anchors.map((a) => (a as HTMLAnchorElement).getAttribute('href')!))
    for (const href of links) {
      if (href.startsWith('#')) {
        expect(await page.locator(`[id="${href.slice(1)}"]`).count(), href).toBe(1)
      } else if (href.startsWith('/') && !href.startsWith('/_astro/')) {
        const target = new URL(href, 'https://phosphor.saccolabs.com')
        expect(routes, href).toContain(target.pathname)
        if (target.hash) {
          const html = await page.request.get(target.pathname)
          expect(await html.text(), href).toContain(`id="${target.hash.slice(1)}"`)
        }
      }
    }
    expect(
      await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth),
    ).toBe(true)
    expect(errors).toEqual([])
    const accessibility = await new AxeBuilder({ page })
      .withTags(['wcag2a', 'wcag2aa', 'wcag21aa'])
      .analyze()
    expect(accessibility.violations).toEqual([])
  })
}

test('screenshot views support clicks, arrow keys, and direct links', async ({ page }) => {
  await page.goto('/')
  const files = page.getByRole('tab', { name: 'Files', exact: true })
  const changes = page.getByRole('tab', { name: 'Changes', exact: true })
  const artifacts = page.getByRole('tab', { name: 'Artifacts', exact: true })
  await expect(files).toHaveAttribute('aria-selected', 'true')
  await changes.click()
  await expect(changes).toHaveAttribute('aria-selected', 'true')
  await expect(page.locator('#view-changes')).toBeVisible()
  await expect(page.locator('#view-files')).toBeHidden()
  await changes.press('ArrowRight')
  await expect(artifacts).toBeFocused()
  await expect(page.locator('#view-artifacts')).toBeVisible()
  await artifacts.press('Home')
  await expect(files).toBeFocused()
  await files.press('ArrowLeft')
  await expect(artifacts).toBeFocused()
  await artifacts.press('Home')
  await files.press('End')
  await expect(artifacts).toBeFocused()
  await page.goto('/#view-changes')
  await expect(changes).toHaveAttribute('aria-selected', 'true')
})

test('copy controls copy only the command and announce success', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async (text: string) => {
          document.documentElement.dataset.copiedCommand = text
        },
      },
    })
  })
  await page.goto('/download')
  await page.getByRole('button', { name: 'Copy Install pi · all platforms' }).click()
  await expect(page.locator('[data-copy-status="pi-command"]')).toHaveText('Command copied.')
  await expect(page.locator('html')).toHaveAttribute(
    'data-copied-command',
    'npm install -g @earendil-works/pi-coding-agent',
  )
  await page.getByRole('button', { name: 'Copy Install Phosphor · macOS and Linux' }).click()
  await expect(page.locator('html')).toHaveAttribute(
    'data-copied-command',
    'curl -fsSL https://github.com/agustinsacco/Phosphor/releases/latest/download/install.sh | sh',
  )
})

test('clipboard failure selects the visible command instead of claiming success', async ({
  page,
}) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', {
      value: {
        writeText: async () => {
          throw new Error('denied')
        },
      },
    })
  })
  await page.goto('/download')
  const button = page.getByRole('button', { name: 'Copy Install pi · all platforms' })
  await button.click()
  await expect(page.locator('[data-copy-status="pi-command"]')).toContainText(
    'Clipboard unavailable',
  )
  await expect(page.locator('#pi-command')).toBeFocused()
  expect(await page.evaluate(() => window.getSelection()?.toString())).toBe(
    'npm install -g @earendil-works/pi-coding-agent',
  )
  await expect(button).toBeEnabled()
})

test('no JavaScript still exposes every view, navigation, commands, and FAQ', async ({
  browser,
  baseURL,
}) => {
  const context = await browser.newContext({
    javaScriptEnabled: false,
    viewport: { width: 390, height: 844 },
  })
  const page = await context.newPage()
  try {
    for (const route of routes) {
      await page.goto(`${baseURL}${route}`)
      await expect(page.locator('h1')).toBeVisible()
      await expect(page.getByRole('navigation', { name: 'Primary', exact: true })).toBeVisible()
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(
        true,
      )
    }
    await page.goto(`${baseURL}/`)
    await expect(page.locator('.evidence-panel:visible')).toHaveCount(3)
    await page.goto(`${baseURL}/download`)
    await expect(page.locator('#pi-command')).toBeVisible()
    await expect(page.locator('[data-copy-command]:visible')).toHaveCount(0)
    await page.getByText('Do I need another model subscription?', { exact: true }).click()
    await expect(page.locator('details').first()).toHaveAttribute('open', '')
  } finally {
    await context.close()
  }
})

test('narrow and zoom-equivalent layouts keep all navigation and content reachable', async ({
  page,
}) => {
  for (const width of [320, 768, 1920]) {
    await page.setViewportSize({ width, height: 1000 })
    for (const route of routes) {
      await page.goto(route)
      expect(
        await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth),
        `${route} at ${width}px`,
      ).toBe(true)
      await expect(
        page
          .getByRole('navigation', { name: 'Primary', exact: true })
          .getByRole('link', { name: 'Get Phosphor' }),
      ).toBeVisible()
    }
  }
})

test('skip link and reduced-motion mode do not depend on entrance animation', async ({ page }) => {
  await page.emulateMedia({ reducedMotion: 'reduce' })
  await page.goto('/')
  await page.keyboard.press('Tab')
  await expect(page.getByRole('link', { name: 'Skip to content' })).toBeFocused()
  await page.keyboard.press('Enter')
  await expect(page.locator('main')).toBeFocused()
  expect(await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior)).toBe(
    'auto',
  )
  expect(await page.evaluate(() => document.getAnimations().length)).toBe(0)
})
