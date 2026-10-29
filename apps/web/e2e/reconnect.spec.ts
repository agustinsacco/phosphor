import type { Page } from '@playwright/test'
import { test, expect } from './fixture'

// First attempt "Connecting", later retries "Reconnecting": either names the machine.
const WAIT = /(Connecting|Reconnecting) to Synthetic Host…/

async function capture(page: Page, path: string): Promise<void> {
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  await page.screenshot({ path, animations: 'disabled' })
}

function waiting(page: Page) {
  return page.getByRole('status').filter({ hasText: WAIT }).first()
}

test('a Host that is still connecting locks every composer and says what it waits for', async ({
  stack,
  page,
}, info) => {
  test.setTimeout(150_000)
  await page.goto(stack.origin)
  await page.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click()
  await expect(page.getByTestId('compact-shell')).toBeVisible()
  const lane = `${stack.origin}/lanes/${stack.hostId}/${stack.laneId}/chat`
  const chat = page.getByRole('textbox', { name: 'Chat message', exact: true })
  for (const width of [400, 1100]) {
    await page.setViewportSize({ width, height: 850 })
    await page.goto(lane)
    const take = page.getByRole('button', { name: 'Take control', exact: true })
    const held = page.getByText('Controlled by you', { exact: true })
    await expect(take.or(held)).toBeVisible()
    if (await take.isVisible()) await take.click()
    await expect(held).toBeVisible()
    await chat.fill(`PHX-kept at ${width}`)

    // The open lane keeps its transcript and draft, locked, under a named wait.
    let release = stack.holdHost()
    try {
      await expect(waiting(page)).toBeVisible()
      await expect(chat).toBeDisabled()
      await expect(chat).toHaveValue(`PHX-kept at ${width}`)
      await expect(page.getByText(/Read-only|Machine not connected/)).toHaveCount(0)
      await expect(take).toHaveCount(0)
      await capture(page, info.outputPath(`1-lane-reconnecting-${width}.png`))
    } finally {
      release()
    }
    await expect(page.getByText('Controlled by you', { exact: true })).toBeVisible()
    await expect(chat).toBeEnabled()
    await expect(chat).toHaveValue(`PHX-kept at ${width}`)
    await expect(page.getByRole('status').filter({ hasText: WAIT })).toHaveCount(0)
    await capture(page, info.outputPath(`2-lane-ready-${width}.png`))

    release = stack.holdHost()
    try {
      // Landing on the lane before its Host answers: one loader that names the machine.
      await page.reload()
      await expect(waiting(page)).toBeVisible()
      await expect(chat).toHaveCount(0)
      await capture(page, info.outputPath(`3-lane-landing-${width}.png`))

      // The start screen waits too, instead of asking to connect the machine.
      await page.goto(`${stack.origin}/new/${stack.hostId}`)
      await expect(waiting(page)).toBeVisible()
      await expect(page.getByPlaceholder('Describe a task or ask a question')).toBeDisabled()
      await expect(page.getByText(/Connect this machine|Machine not connected/)).toHaveCount(0)
      await capture(page, info.outputPath(`4-new-lane-connecting-${width}.png`))

      await page.goto(`${stack.origin}/lanes/${stack.hostId}`)
      await expect(waiting(page)).toBeVisible()
      await capture(page, info.outputPath(`5-lanes-connecting-${width}.png`))
    } finally {
      release()
    }
    await expect(
      page.locator('main.compact-main').getByRole('button', { name: 'Synthetic acceptance lane' }),
    ).toBeVisible()
  }
})
