import type { Page } from '@playwright/test'
import { test, expect } from './fixture'

/** Real touch pointer delivery in Chromium; WebKit's driver exposes only taps, so use its mouse. */
async function draw(page: Page, browserName: string, touch: boolean): Promise<void> {
  const box = (await page.getByTestId('image-editor-canvas').boundingBox())!
  const from = { x: box.x + box.width * 0.15, y: box.y + box.height * 0.2 }
  const to = { x: box.x + box.width * 0.7, y: box.y + box.height * 0.7 }
  if (touch && browserName === 'chromium') {
    const session = await page.context().newCDPSession(page)
    try {
      await session.send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [from] })
      await session.send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [to] })
      await session.send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] })
    } finally {
      await session.detach()
    }
  } else {
    await page.mouse.move(from.x, from.y)
    await page.mouse.down()
    await page.mouse.move(to.x, to.y, { steps: 5 })
    await page.mouse.up()
  }
}

async function attachWhiteImage(page: Page): Promise<string> {
  const png = await page.evaluate(() => {
    const canvas = document.createElement('canvas')
    canvas.width = 300
    canvas.height = 200
    const ctx = canvas.getContext('2d')!
    ctx.fillStyle = '#ffffff'
    ctx.fillRect(0, 0, 300, 200)
    return canvas.toDataURL('image/png').split(',')[1]!
  })
  const chosen = page.waitForEvent('filechooser')
  await page.getByRole('button', { name: 'Attach files', exact: true }).click()
  await (
    await chosen
  ).setFiles({ name: 'test.png', mimeType: 'image/png', buffer: Buffer.from(png, 'base64') })
  return png
}

async function phoneToolbar(page: Page): Promise<void> {
  const editor = page.getByRole('dialog', { name: 'Annotate image' })
  await page.setViewportSize({ width: 360, height: 850 })
  await expect(async () => {
    const layout = await editor.evaluate((el) => ({
      width: el.getBoundingClientRect().width,
      overflow: el.scrollWidth > el.clientWidth,
      targets: [...el.querySelectorAll('button')].map((b) => ({
        w: b.getBoundingClientRect().width,
        h: b.getBoundingClientRect().height,
      })),
    }))
    expect(layout.width).toBe(360)
    expect(layout.overflow).toBe(false)
    expect(layout.targets.every((b) => b.w >= 44 && b.h >= 44)).toBe(true)
  }).toPass()
  await page.setViewportSize({ width: 400, height: 850 })
}

async function imageActions(page: Page, browserName: string, width: number): Promise<void> {
  const image = page.getByRole('button', { name: 'Attached image', exact: true }).last()
  await image.click()
  const fullImage = page.getByRole('img', { name: 'Attached image, full size', exact: true })
  await expect(fullImage).toBeVisible()
  if (width === 400) {
    const picture = (await fullImage.boundingBox())!
    const actions = (await page
      .getByRole('button', { name: 'Save image', exact: true })
      .locator('..')
      .boundingBox())!
    expect(picture.height).toBeGreaterThan(0)
    expect(picture.y + picture.height).toBeLessThanOrEqual(actions.y)
  }
  const download = page.waitForEvent('download')
  await page.getByRole('button', { name: 'Save image', exact: true }).click()
  expect((await download).suggestedFilename()).toBe('image.png')
  if (browserName === 'chromium') {
    await page.getByRole('button', { name: 'Copy image', exact: true }).click()
    await expect(page.getByText('Image copied', { exact: true })).toBeVisible()
    expect(await page.evaluate(async () => (await navigator.clipboard.read())[0]!.types)).toContain(
      'image/png',
    )
  }
  await page.keyboard.press('Escape')
  if (width === 400) {
    expect(await image.getAttribute('data-tooltip-description')).toBeNull()
    await image.dispatchEvent('pointerdown', { pointerType: 'touch', clientX: 20, clientY: 20 })
    await expect(page.getByTestId('context-menu-sheet')).toContainText('Save image')
    await image.dispatchEvent('pointerup', { pointerType: 'touch' })
  } else {
    await expect(image).toHaveAttribute('data-tooltip-description', 'Right-click to copy')
    if (browserName === 'chromium') {
      // Wait out the copy-button toast so this assertion can only pass for the right click.
      await expect(page.getByText('Image copied', { exact: true })).toBeHidden()
      await image.click({ button: 'right' })
      await expect(page.getByText('Image copied', { exact: true })).toBeVisible()
    }
  }
}

async function openAnnotator(page: Page, width: number): Promise<void> {
  const thumbnail = page
    .getByTestId('attachment-chips')
    .getByRole('button', { name: 'Attached image', exact: true })
  if (width === 400) return thumbnail.click()
  await thumbnail.hover()
  const box = (await thumbnail.boundingBox())!
  const point = { x: box.x + box.width - 15, y: box.y + 15 }
  expect(
    await thumbnail.evaluate(
      (el, point) => el.contains(document.elementFromPoint(point.x, point.y)),
      point,
    ),
  ).toBe(true)
  await page.mouse.click(point.x, point.y)
}

for (const width of [400, 1100]) {
  test.describe(width === 400 ? 'phone touch' : 'wide mouse', () => {
    test.use({ hasTouch: width === 400, isMobile: width === 400 })
    test(`Host image annotation, send and image actions at ${width}px`, async ({
      stack,
      page,
      context,
      browserName,
    }, info) => {
      await page.setViewportSize({ width, height: 850 })
      if (browserName === 'chromium')
        await context.grantPermissions(['clipboard-read', 'clipboard-write'], {
          origin: stack.origin,
        })
      await page.goto(stack.origin)
      await page.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click()
      await expect(page.getByTestId('home-board')).toBeVisible()
      await page.goto(`${stack.origin}/lanes/${stack.hostId}/${stack.laneId}/chat`)
      await page.getByRole('button', { name: 'Take control', exact: true }).click()
      await expect(page.getByText('Controlled by you', { exact: true })).toBeVisible()
      const png = await attachWhiteImage(page)
      const chips = page.getByTestId('attachment-chips')
      await openAnnotator(page, width)
      const editor = page.getByRole('dialog', { name: 'Annotate image' })
      await expect(page.getByTestId('image-editor-canvas')).toBeVisible()
      if (width === 400) await phoneToolbar(page)
      await draw(page, browserName, width === 400)
      await expect(editor.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled()
      await editor.getByRole('button', { name: 'Undo', exact: true }).click()
      await expect(editor.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled()
      await editor.getByRole('button', { name: 'Redo', exact: true }).click()
      await page.screenshot({ path: info.outputPath(`annotator-${width}.png`) })
      await editor.getByRole('button', { name: 'Done', exact: true }).click()
      await expect(editor).toBeHidden()
      expect(await chips.locator('img').getAttribute('src')).not.toBe(
        `data:image/png;base64,${png}`,
      )
      await page.getByRole('textbox', { name: 'Chat message', exact: true }).fill('PHX-hostinputs')
      expect(
        await page
          .getByRole('button', { name: 'Send message', exact: true })
          .evaluate(async (el) => {
            ;(el as HTMLButtonElement).click()
            await Promise.resolve()
            return {
              draft: document.querySelector('textarea')?.value,
              pending: !!document.querySelector('[data-testid="booting-indicator"]'),
            }
          }),
      ).toEqual({ draft: '', pending: true })
      await expect(chips).toHaveCount(0)
      await expect(page.getByText('Attachments: | 1 image/png', { exact: true })).toBeVisible()
      const image = page.getByRole('button', { name: 'Attached image', exact: true }).last()
      await expect(image).toBeVisible()
      await imageActions(page, browserName, width)
      await page.screenshot({ path: info.outputPath(`image-actions-${width}.png`) })
    })
  })
}
