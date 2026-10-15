import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { remoteHostFixture } from './fixtures/remote-host'

test('Desktop streams a real Host lane, reads Files and becomes a viewer on control takeover', async () => {
  const h = await remoteHostFixture()
  try {
    await h.signIn()
    const switcher = h.page.getByRole('button', { name: 'Machine filter', exact: true })
    await expect(switcher).toContainText('This Mac')
    await switcher.click()
    await h.page.getByRole('option').filter({ hasText: 'bee1' }).click()
    const sidebar = h.page.getByRole('region', { name: 'bee1', exact: true })
    const lane = sidebar.getByRole('button', { name: /Remote test lane/ })
    await expect(sidebar).toHaveAttribute('aria-label', 'bee1')
    await lane.click()
    await h.page.getByRole('button', { name: 'Take control', exact: true }).click()
    await expect(h.page.getByText('Controlled by you', { exact: true })).toBeVisible()
    const composer = h.page.getByRole('textbox', { name: 'Chat message', exact: true })
    await composer.fill('stream remote response')
    await composer.press('Enter')
    const reply = h.page.locator('main p').filter({ hasText: /^1 2 / }).first()
    await expect(reply).toContainText('1 2 3')
    const partial = await reply.innerText()
    await expect.poll(() => reply.innerText()).not.toBe(partial)
    const requestId = randomUUID()
    h.send({ type: 'command', requestId, laneId: h.laneId, op: { type: 'control.take' } })
    await expect
      .poll(() =>
        h.frames.some(
          (f) =>
            f.type === 'receipt' &&
            f.receipt.requestId === requestId &&
            f.receipt.status === 'done',
        ),
      )
      .toBe(true)
    await expect(h.page.getByText('Controlled by Second client', { exact: true })).toBeVisible()
    await expect(h.page.getByRole('status')).toContainText(
      'Read-only. Take control to send messages.',
    )
    await expect(composer).toHaveCount(0)
    await expect(h.page.getByRole('button', { name: 'Take control', exact: true })).toBeVisible()
    await h.page.getByRole('button', { name: /^Files pane/ }).click()
    await h.page.getByRole('treeitem', { name: /^remote\.txt/ }).click()
    await expect(h.page.locator('.monaco-editor')).toContainText('REMOTE_FILE_FROM_REAL_HOST')
  } finally {
    await h.close()
  }
})
