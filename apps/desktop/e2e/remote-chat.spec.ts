import { test, expect } from '@playwright/test'
import { remoteHostFixture } from './fixtures/remote-host'
import { openRemote, takeControl, sendTurn } from './fixtures/remote-ui'

test('Send, steer, follow up and abort have one remote echo; model, thinking and compact work', async () => {
  test.setTimeout(25_000)
  const h = await remoteHostFixture()
  try {
    await h.signIn()
    await openRemote(h)
    await takeControl(h)
    const chat = h.page.getByRole('textbox', { name: 'Chat message', exact: true })
    await chat.fill('stream remote response')
    await chat.press('Enter')
    const stream = h.page.locator('main p').filter({ hasText: /^1 2 / }).first()
    await expect(stream).toContainText('1 2 3')
    const partial = await stream.innerText()
    await expect.poll(() => stream.innerText()).not.toBe(partial)
    await chat.fill('PHX-steered')
    await h.page.getByRole('button', { name: 'Steer now', exact: true }).click()
    await chat.fill('PHX-followed')
    await h.page.getByRole('button', { name: 'Queue follow-up', exact: true }).click()
    await expect(h.page.getByText('PHX-steered', { exact: true })).toBeVisible()
    await expect(h.page.getByText('PHX-followed', { exact: true })).toBeVisible()
    await h.page
      .getByRole('button', { name: 'Stop', exact: true })
      .and(h.page.locator('[aria-label="Stop"]'))
      .click()
    await expect(h.page.getByText('PHX-steered', { exact: true })).toHaveCount(2)
    await expect(h.page.getByText('PHX-followed', { exact: true })).toHaveCount(2)
    await expect(
      h.page
        .getByRole('button', { name: 'Stop', exact: true })
        .and(h.page.locator('[aria-label="Stop"]')),
    ).toBeHidden()
    await expect(h.page.getByText('stopped', { exact: true })).toBeVisible()
    await h.page.getByTestId('model-chip').click()
    await h.page.getByTestId('model-search').fill('HOST_B_ONLY')
    await h.page.getByTestId('model-row').filter({ hasText: 'HOST_B_ONLY' }).click()
    await expect(h.page.getByTestId('model-chip')).toContainText('HOST_B_ONLY')
    await h.page.getByTestId('thinking-chip').click()
    await h.page.getByRole('button', { name: 'High', exact: true }).click()
    await expect(h.page.getByTestId('thinking-chip')).toContainText('High')
    await sendTurn(h, 'PHX-modelchanged')
    await chat.fill('/compact')
    await chat.press('Enter')
    await expect(h.page.getByText('Context compacted', { exact: true })).toBeVisible()
    await h.page.getByText('show summary', { exact: true }).click()
    await expect(h.page.getByText('HOST_A_ONLY compacted', { exact: true })).toBeVisible()
    await expect(h.page.getByText('compacting…', { exact: true })).toBeHidden()
    await sendTurn(h, 'PHX-aftercompact')
    expect(await h.localSentinel()).toBe('LOCAL_ONLY decoy\n')
  } finally {
    await h.close()
  }
})

test('Continue has exactly one remote echo', async () => {
  test.setTimeout(25_000)
  const h = await remoteHostFixture()
  try {
    await h.signIn()
    await openRemote(h)
    await takeControl(h)
    const chat = h.page.getByRole('textbox', { name: 'Chat message', exact: true })
    await chat.fill('stream continue test')
    await chat.press('Enter')
    await expect(h.page.locator('main p').filter({ hasText: /^1 2 / })).toBeVisible()
    await h.page.locator('button[aria-label="Stop"]').click()
    await expect(h.page.getByText('stopped', { exact: true })).toBeVisible()
    await chat.fill('draft preserved')
    await h.page.getByRole('button', { name: 'Continue', exact: true }).click()
    await expect(h.page.locator('main').getByText('continue', { exact: true })).toHaveCount(1)
    await expect(h.page.locator('main').getByText('ok', { exact: true })).toHaveCount(1)
    await expect(chat).toHaveValue('draft preserved')
    const restore = h.severConnection()
    try {
      await expect(h.page.getByText(/Reconnecting|Connecting/).first()).toBeVisible()
    } finally {
      restore()
    }
    await expect(h.page.getByText('Controlled by you', { exact: true })).toBeVisible()
    await expect(h.page.locator('main').getByText('continue', { exact: true })).toHaveCount(1)
    await sendTurn(h, 'PHX-aftercontinue')
  } finally {
    await h.close()
  }
})

test('Remote slash, mentions and attachments use Host inputs', async () => {
  test.setTimeout(25_000)
  const h = await remoteHostFixture()
  try {
    await h.signIn()
    await openRemote(h)
    await takeControl(h)
    const chat = h.page.getByRole('textbox', { name: 'Chat message', exact: true })
    await chat.fill('/host')
    await expect(h.page.getByText('/host-only', { exact: true })).toBeVisible()
    await chat.fill('/host-only')
    await h.page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect(h.page.getByText('HOST_A_ONLY command handled', { exact: true })).toBeVisible()
    await expect(h.page.locator('main').getByText('ok', { exact: true })).toHaveCount(0)
    await chat.fill('@guide')
    await expect(h.page.getByText('nested/guide.md', { exact: true })).toBeVisible()
    await expect(h.page.getByText('LOCAL_ONLY decoy', { exact: true })).toHaveCount(0)
    await chat.fill('!echo LOCAL_ONLY')
    await chat.press('Enter')
    await expect(chat).toHaveValue('!echo LOCAL_ONLY')
    await expect(
      h.page.getByText('Not available on remote lanes yet.', { exact: true }),
    ).toBeVisible()
    const chosen = h.page.waitForEvent('filechooser')
    await h.page.getByRole('button', { name: 'Attach files', exact: true }).click()
    await (
      await chosen
    ).setFiles([
      {
        name: 'host-document.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('HOST_A_ONLY document'),
      },
      {
        name: 'host-image.png',
        mimeType: 'image/png',
        buffer: Buffer.from(
          'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jRZkAAAAASUVORK5CYII=',
          'base64',
        ),
      },
    ])
    await expect(h.page.getByTestId('attachment-chips')).toContainText('host-document.txt')
    await h.page.getByTestId('attachment-chips').getByRole('img').hover()
    await expect(
      h.page.getByRole('button', { name: 'Remove host-image.png', exact: true }),
    ).toBeVisible()
    await chat.fill('PHX-hostinputs')
    await h.page.getByRole('button', { name: 'Send message', exact: true }).click()
    await expect(
      h.page
        .locator('main')
        .getByText('Attachments: HOST_A_ONLY document | 1 image/png', { exact: true }),
    ).toBeVisible()
    await expect(h.page.getByTestId('attachment-chips')).toHaveCount(0)
    expect(await h.localSentinel()).toBe('LOCAL_ONLY decoy\n')
  } finally {
    await h.close()
  }
})
