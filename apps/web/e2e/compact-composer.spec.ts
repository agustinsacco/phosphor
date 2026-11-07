import type { Locator, Page } from '@playwright/test'
import { test, expect } from './fixture'

// A phone: touch, no hover, so Return adds a line and 44px hit areas apply.
test.use({ hasTouch: true, isMobile: true })

const DRAFT = Array.from(
  { length: 24 },
  (_, n) => `Line ${n + 1} of a long phone draft that wraps across the composer.`,
).join(' ')

/** Elements that scroll vertically right now, other than the transcript and the field. */
async function extraScrollers(page: Page): Promise<string[]> {
  return page.evaluate(() =>
    [...document.querySelectorAll<HTMLElement>('.compact-shell *')]
      .filter((el) => {
        const style = getComputedStyle(el)
        return (
          /(auto|scroll)/.test(style.overflowY) &&
          el.clientHeight > 0 &&
          el.scrollHeight > el.clientHeight + 1 &&
          !el.matches(
            'textarea, [data-testid="transcript-scroll"], [data-testid="transcript-scroll"] *',
          )
        )
      })
      .map((el) => `${el.tagName}.${el.className.toString().slice(0, 60)}`),
  )
}

/** The field against the shell's bottom, and whether it shows its last line. */
function fieldState(field: Locator) {
  return field.evaluate((el) => {
    const box = el.getBoundingClientRect()
    return {
      bottom: box.bottom,
      shellBottom: document.querySelector('.compact-shell')!.getBoundingClientRect().bottom,
      height: box.height,
      atEnd: el.scrollTop + el.clientHeight >= el.scrollHeight - 2,
    }
  })
}

/** Distinct rows of toolbar controls, the narrowest control, and whether all sit in the card. */
function toolbarLayout(page: Page) {
  return page.getByTestId('composer-toolbar').evaluate((toolbar) => {
    const card = toolbar.parentElement!.getBoundingClientRect()
    const boxes = [...toolbar.querySelectorAll('button')]
      .map((b) => b.getBoundingClientRect())
      .filter((box) => box.height > 0)
    return {
      rows: new Set(boxes.map((box) => Math.round(box.top + box.height / 2))).size,
      narrowest: Math.min(...boxes.map((box) => box.width)),
      inside: boxes.every((box) => box.left >= card.left && box.right <= card.right + 0.5),
    }
  })
}

async function signIn(page: Page, origin: string): Promise<void> {
  await page.goto(origin)
  await page.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click()
  await expect(page.getByTestId('home-board')).toBeVisible()
}

test('the phone lane composer keeps one control row, one scroller and the caret in view', async ({
  stack,
  page,
}, info) => {
  await page.setViewportSize({ width: 320, height: 760 })
  await signIn(page, stack.origin)
  await page.goto(`${stack.origin}/lanes/${stack.hostId}/${stack.laneId}/chat`)
  const take = page.getByRole('button', { name: 'Take control', exact: true })
  const held = page.getByText('Controlled by you', { exact: true })
  await expect(take.or(held)).toBeVisible()
  if (await take.isVisible()) await take.click()
  await expect(held).toBeVisible()

  const chat = page.getByRole('textbox', { name: 'Chat message', exact: true })
  await chat.fill('A short draft')
  // Every control shares one row: the model name truncates instead of wrapping.
  expect((await toolbarLayout(page)).rows).toBe(1)
  expect(await extraScrollers(page)).toEqual([])
  await page.screenshot({ path: info.outputPath('lane-composer-320.png') })

  // A typed `/` menu opens above the composer: Send stays tappable under it.
  await chat.fill('/no-such-command')
  const menu = (await page.locator('[data-compact-menu]').boundingBox())!
  const card = (await page.getByTestId('composer-toolbar').locator('..').boundingBox())!
  expect(menu.y + menu.height).toBeLessThanOrEqual(card.y)
  await page.getByRole('button', { name: 'Send message', exact: true }).click({ trial: true })

  // Too narrow for one row: the right group takes its own line, and no control is crushed.
  await page.setViewportSize({ width: 240, height: 760 })
  const narrow = await toolbarLayout(page)
  expect(narrow.narrowest).toBeGreaterThanOrEqual(24)
  expect(narrow.inside).toBe(true)
  await page.setViewportSize({ width: 320, height: 760 })

  // The keyboard leaves half the screen: the field stops growing and scrolls itself.
  await page.setViewportSize({ width: 412, height: 480 })
  await chat.fill(DRAFT)
  await chat.press('End')
  // Viewport updates and the textarea's ResizeObserver settle on animation frames.
  // Keep every geometry assertion, but re-read the layout instead of freezing one early frame.
  await expect(async () => {
    const field = await fieldState(chat)
    expect(field.bottom).toBeLessThanOrEqual(field.shellBottom)
    expect(field.height).toBeLessThanOrEqual(480 * 0.35)
    expect(field.atEnd).toBe(true)
    expect(await extraScrollers(page)).toEqual([])
  }).toPass({ timeout: 15_000 })
})

test('the phone new-lane page scrolls once, never its composer, and keeps the caret in view', async ({
  stack,
  page,
}, info) => {
  await signIn(page, stack.origin)
  await page.setViewportSize({ width: 412, height: 480 })
  await page.goto(`${stack.origin}/new/${stack.hostId}`)
  await expect(page.getByTestId('remote-model-picker')).toBeVisible()
  const start = page.getByRole('textbox', { name: 'Chat message', exact: true })
  await start.fill(DRAFT)
  await start.press('End')
  await expect(async () => {
    const field = await fieldState(start)
    expect(field.bottom).toBeLessThanOrEqual(field.shellBottom)
    expect(field.atEnd).toBe(true)
  }).toPass({ timeout: 15_000 })
  await expect(page.getByRole('button', { name: 'Start lane', exact: true })).toBeInViewport()
  const nested = await page
    .locator('.remote-start')
    .evaluate((el) => el.scrollHeight > el.clientHeight + 1)
  expect(nested).toBe(false)
  await page.screenshot({ path: info.outputPath('new-lane-keyboard.png') })
})
