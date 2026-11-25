import { test, expect, type Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launch, shutdown, openWorkspace, type Harness } from './fixtures/local-app'
import { scratchDir } from './fixtures/scratch'

/*
 * The composer must never send a plain prompt pi refuses because it is still
 * processing, and must never show pi's own words for it. The stub's
 * `pi-stub-busy.cjs` scenarios hold pi busy while the chat alone reads idle.
 */

type Prompt = { type: string; message?: string; streamingBehavior?: string }

async function start(
  scenario: string,
): Promise<{ harness: Harness; prompts: () => Promise<Prompt[]> }> {
  const workspace = await scratchDir('phosphor-steer-busy-')
  const log = join(workspace, 'commands.jsonl')
  const harness = await launch({ workspace, env: { PHOSPHOR_E2E_COMMAND_LOG: log } })
  await openWorkspace(harness.page)
  await harness.page.getByPlaceholder('Describe a task or ask a question').fill(scenario)
  await harness.page.getByRole('button', { name: /Start lane/i }).click()
  const prompts = async () =>
    (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as Prompt)
      .filter((cmd) => cmd.type === 'prompt' && cmd.message !== scenario)
      .map(({ message, streamingBehavior }) => ({ type: 'prompt', message, streamingBehavior }))
  return { harness, prompts }
}

async function expectNoSessionError(page: Page) {
  await expect(page.getByText('Session error')).toBeHidden()
  await expect(page.getByText(/already processing|streamingBehavior/)).toBeHidden()
}

test('a prompt between run end and settle queues on the first attempt', async () => {
  const { harness, prompts } = await start('post-run-hold')
  const { page } = harness
  try {
    const chat = page.getByRole('textbox', { name: 'Chat message' })
    // The run ended: the chat reads idle while pi has not settled.
    await expect(page.getByText('Held after the run.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Send message' })).toBeVisible()
    await chat.fill('PHX-gap')
    await chat.press('Enter')
    await expect
      .poll(prompts)
      .toEqual([{ type: 'prompt', message: 'PHX-gap', streamingBehavior: 'followUp' }])
    await expect(chat).toHaveValue('')
    // Queued, so it enters the transcript only when pi delivers it.
    await expect(page.getByTestId('user-message')).toHaveText(['post-run-hold'])
    await expectNoSessionError(page)
  } finally {
    await shutdown(harness)
  }
})

test('background agents keep Steer now and Queue follow-up, and Enter steers', async () => {
  const { harness, prompts } = await start('delegated-hold')
  const { page } = harness
  try {
    const chat = page.getByRole('textbox', { name: 'Chat message' })
    await expect(page.getByText('Delegated to a reviewer.')).toBeVisible()
    await expect(page.getByRole('button', { name: 'Stop', exact: true })).toBeHidden()
    await chat.fill('PHX-steer')
    await expect(page.getByRole('button', { name: 'Steer now' })).toBeVisible()
    await expect(page.getByRole('button', { name: 'Queue follow-up' })).toBeVisible()
    await chat.press('Enter')
    await expect
      .poll(prompts)
      .toEqual([{ type: 'prompt', message: 'PHX-steer', streamingBehavior: 'steer' }])
    // pi was idle, so the steer started a run and pi's echo is the bubble.
    await expect(page.getByTestId('user-message')).toHaveText(['delegated-hold', 'PHX-steer'])
    await expect(page.getByText('Read: PHX-steer')).toBeVisible()
    await expectNoSessionError(page)
  } finally {
    await shutdown(harness)
  }
})
