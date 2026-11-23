/* global window */
import { expect } from '@playwright/test'
import { source, root, shot, settings, closeSettings } from './capture-harness.mjs'

export async function captureBrain(page) {
  await page.evaluate(async (root) => {
    const { installBrainDemo } = await import(
      `/@fs${root}apps/site/scripts/fixtures/brain-backend.mjs`
    )
    installBrainDemo()
  }, root)
  await captureSetup(page)
  await captureKnowledge(page)
  await page.getByRole('tab', { name: 'Lanes', exact: true }).click()
  await page
    .getByRole('region', { name: 'Brain lanes', exact: true })
    .getByRole('button', { name: /Harbor pilot planning/ })
    .click()
  const waiting = page.getByRole('article', { name: 'Waiting read', exact: true })
  await expect(waiting).toContainText('Waits for Defrag')
  await expect(waiting).toContainText('Rina Okafor owns Harbor Ledger migrations.')
  await expect(page.getByRole('button', { name: 'Defrag', exact: true })).toBeEnabled()
  await expect(page.getByRole('heading', { level: 1, name: /^Brain / })).toContainText('1 waiting')
  await shot(page, 'brain-review')
  await page.getByRole('button', { name: 'See how it was read', exact: true }).click()
  await page.getByRole('article', { name: 'Read detail', exact: true }).waitFor()
  await shot(page, 'brain-extraction')
  await page.getByRole('button', { name: 'Back to waiting read', exact: true }).click()
  await page.getByRole('tab', { name: 'Knowledge', exact: true }).click()
  const search = page.getByRole('combobox', { name: 'Search people, things, memories' })
  await search.fill('Rina Okafor owns')
  await page.getByRole('option', { name: /Rina Okafor owns Harbor Ledger migrations/ }).waitFor()
  await search.press('Enter')
  await expect(page.getByRole('region', { name: 'Profile', exact: true })).toContainText(
    'Keep this responsibility explicit in the rollout checklist.',
  )
  await shot(page, 'brain-memory')
  await captureQueue(page)
  await closeSettings(page)
}

async function captureSetup(page) {
  await settings(page, 'brain')
  await expect(page.getByText('Gemma Terms of Use', { exact: true })).toBeVisible()
  await shot(page, 'brain-setup', page.getByRole('dialog', { name: 'Settings', exact: true }))
  await page.getByRole('switch', { name: 'Brain', exact: true }).click()
  await expect(
    page.getByText('EmbeddingGemma is ready. Search runs on this computer.'),
  ).toBeVisible({ timeout: 12000 })
  await shot(page, 'brain-ready', page.getByRole('dialog', { name: 'Settings', exact: true }))
  await page.getByRole('button', { name: 'Open Brain', exact: true }).click()
}

async function captureKnowledge(page) {
  const search = page.getByRole('combobox', { name: 'Search people, things, memories' })
  await search.fill('Harbor Ledger')
  await page.getByRole('option', { name: /^Harbor Ledger \d+ memories$/ }).waitFor()
  await search.press('Enter')
  await page.getByRole('button', { name: 'Full map', exact: true }).click()
  await page.getByRole('region', { name: 'Graph explorer' }).waitFor()
  await page.getByRole('button', { name: '2D', exact: true }).click()
  await page.getByRole('button', { name: 'Fit the graph', exact: true }).click()
  await page.waitForTimeout(1200)
  await shot(page, 'brain-graph')
  await page.getByRole('button', { name: 'Back to profile', exact: true }).click()
}

async function captureQueue(page) {
  await page.evaluate(async (source) => {
    await window.phosphor.invoke('brain:queue', {
      sessionId: 'harbor-pilot-checkpoint',
      sessionPath: '/demo/Harbor/checkpoint.jsonl',
      title: 'Harbor rollout checkpoint',
      scope: '/demo/Harbor',
      branch: null,
      model: 'demo/harbor-model',
    })
    const { useBrain } = await import(`${source}features/brain/useBrain.ts`)
    await useBrain.getState().refresh()
  }, source)
  await page.getByRole('tab', { name: 'Lanes', exact: true }).click()
  await page
    .getByRole('region', { name: 'Brain lanes', exact: true })
    .getByRole('button', { name: /Harbor rollout checkpoint/ })
    .click()
  await expect(page.getByRole('region', { name: 'Lane detail', exact: true })).toContainText(
    'Harbor rollout checkpoint',
  )
  await shot(page, 'brain-queue')
}
