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
  await settings(page, 'brain')
  await expect(page.getByText('Gemma Terms of Use', { exact: true })).toBeVisible()
  await shot(page, 'brain-setup', page.getByRole('dialog', { name: 'Settings', exact: true }))
  await page.getByRole('switch', { name: 'Brain', exact: true }).click()
  await expect(
    page.getByText('EmbeddingGemma is ready. Search runs on this computer.'),
  ).toBeVisible({ timeout: 12000 })
  await shot(page, 'brain-ready', page.getByRole('dialog', { name: 'Settings', exact: true }))
  await page.getByRole('button', { name: 'Open Brain', exact: true }).click()
  await page.getByRole('region', { name: 'Graph explorer' }).waitFor()
  await page
    .getByRole('combobox', { name: 'Find a person, project or memory' })
    .fill('Harbor Ledger')
  await page.waitForTimeout(500)
  await page.keyboard.press('Enter')
  await page.waitForTimeout(2000)
  await page.getByRole('button', { name: '2D', exact: true }).click()
  await page.getByRole('button', { name: 'Fit', exact: true }).click()
  await page.waitForTimeout(1200)
  await shot(page, 'brain-graph')
  await page.getByRole('button', { name: 'Review', exact: true }).click()
  await page.getByText('Same name; please confirm the project context.').waitFor()
  await shot(page, 'brain-review')
  await page.getByRole('button', { name: 'View extraction', exact: true }).click()
  await page.getByRole('region', { name: 'Extraction detail' }).waitFor()
  await shot(page, 'brain-extraction')
  await page.getByRole('button', { name: 'Back', exact: true }).last().click()
  const search = page.getByRole('combobox', { name: 'Find a person, project or memory' })
  await search.fill('Rina Okafor owns')
  await page.waitForTimeout(500)
  await search.press('Enter')
  await page.getByRole('article', { name: 'Memory detail' }).waitFor()
  await page.getByRole('button', { name: 'Fit', exact: true }).click()
  await shot(page, 'brain-memory')
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
  await page.getByText('Harbor rollout checkpoint', { exact: true }).waitFor()
  await shot(page, 'brain-queue')
  await closeSettings(page)
}
