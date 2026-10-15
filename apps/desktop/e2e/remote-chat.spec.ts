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

test.fixme('Continue has exactly one remote echo (phase 2)', async () => {
  // Start stream; abort; click Continue; exactly one user bubble and one reply.
  // Assert one ordered transcript after reconnect and a subsequent successful prompt.
})

test.fixme('Remote slash, mentions and attachments use Host inputs (phase 2)', async () => {
  // `/` offers Host-only extension, no local-only command; execute handled command and assert its
  // response/no spurious turn; `@` lists nested Host file, not local decoy; attach document and
  // image, assert attachment chip and Host-derived response, not local absolute path. Refuse upload
  // and !shell; draft/attachment retained, no reply; unavailable queue removal/rewind/fork has
  // reason or is absent.
})
