import { expect, type Page } from '@playwright/test'
import type { BrainLane } from './brain-lanes'

export const brainNav = (page: Page) =>
  page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: 'Brain', exact: true })
const laneRow = (page: Page, lane: BrainLane) =>
  page.getByTestId('session-row').filter({ hasText: lane.title }).first()
export const inbox = (page: Page, lane: BrainLane) =>
  page
    .getByRole('region', { name: 'Inbox', exact: true })
    .getByRole('article')
    .filter({ hasText: lane.title })
export const status = (page: Page) => page.evaluate(() => window.phosphor.invoke('brain:status'))

export async function enableBrain(page: Page, lane: BrainLane): Promise<void> {
  const row = laneRow(page, lane)
  await expect(row).toBeVisible({ timeout: 30_000 })
  await expect(brainNav(page)).toHaveCount(0)
  await row.click({ button: 'right' })
  await expect(page.getByText('Queue for knowledge extraction')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Brain', exact: true }).click()
  await page.getByRole('switch', { name: 'Brain', exact: true }).click()
  await expect(page.getByRole('switch', { name: 'Brain', exact: true })).toBeChecked()
  await expect(page.getByRole('switch', { name: 'Review before saving' })).toBeChecked()
  await expect(page.getByText('EmbeddingGemma is ready.', { exact: false })).toBeVisible()
  await page.keyboard.press('Escape')
  await brainNav(page).click()
}

export async function queueLane(page: Page, lane: BrainLane): Promise<void> {
  await laneRow(page, lane).click({ button: 'right' })
  await page.getByText('Queue for knowledge extraction', { exact: true }).click()
}

export async function approveLane(page: Page, lane: BrainLane): Promise<string> {
  await expect(inbox(page, lane).getByText('2 memories to review')).toBeVisible({ timeout: 30_000 })
  const job = (await status(page)).jobs.find((job) => job.sessionPath === lane.source)!
  await inbox(page, lane).getByRole('button', { name: 'Review', exact: true }).click()
  const review = page.getByRole('region', { name: 'Review memories', exact: true })
  await expect(review.getByRole('region', { name: 'Who/what is this?', exact: true })).toBeVisible()
  await expect(review.getByText('Nothing is searchable until you approve it.')).toBeVisible()
  for (const fact of lane.facts)
    await expect(review.getByText(fact, { exact: true }).first()).toBeVisible()
  const links = page.getByRole('region', { name: 'Proposed memories', exact: true })
  if (lane.title === 'Harbor ledger') {
    await expect(
      links.getByText('Rina Okafor → owns → Harbor ledger', { exact: true }),
    ).toBeVisible()
    await expect(links.getByText('Harbor ledger → part of → Harbor', { exact: true })).toBeVisible()
  } else {
    await expect(links.getByText('Tom Lee → owns → Ledger bridge', { exact: true })).toBeVisible()
    await expect(links.getByText('Ledger bridge → part of → Harbor', { exact: true })).toBeVisible()
    await expect(
      review.getByRole('region', { name: 'Who/what is this?', exact: true }),
    ).toContainText('same as Harbor')
  }
  await review.getByRole('button', { name: 'Approve 2', exact: true }).click()
  await expect(review).toHaveCount(0)
  return job.id
}

export async function exploreBrain(page: Page): Promise<void> {
  await page.keyboard.press('/')
  const search = page.getByRole('combobox', { name: 'Find a person, project or memory' })
  await expect(search).toBeFocused()
  await search.fill('Harbor')
  await expect(page.getByRole('option').first()).toContainText('Harbor')
  await search.press('Enter')
  const detail = page.getByRole('article', { name: 'Entity detail' })
  await expect(detail.getByRole('heading', { name: 'Harbor', exact: true })).toBeVisible()
  await detail
    .getByRole('region', { name: 'Connections', exact: true })
    .getByRole('button', { name: 'Harbor ledger', exact: true })
    .click()
  await expect(detail.getByRole('heading', { name: 'Harbor ledger', exact: true })).toBeVisible()
  await expect(detail.getByRole('region', { name: 'Entity memories' })).toContainText(
    'Rina Okafor owns Harbor ledger.',
  )
  await detail
    .getByRole('region', { name: 'Connections', exact: true })
    .getByRole('button', { name: 'Rina Okafor', exact: true })
    .click()
  await expect(detail.getByRole('heading', { name: 'Rina Okafor', exact: true })).toBeVisible()
  const trail = page.getByRole('navigation', { name: 'Brain trail' })
  await trail.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(detail.getByRole('heading', { name: 'Harbor ledger', exact: true })).toBeVisible()
  await trail.getByRole('button', { name: 'Forward', exact: true }).click()
  await expect(detail.getByRole('heading', { name: 'Rina Okafor', exact: true })).toBeVisible()
  await detail.getByRole('button', { name: 'Find a path to…', exact: true }).click()
  const target = detail.getByRole('combobox', { name: 'Find an entity' })
  await target.fill('Harbor')
  await expect(detail.getByRole('option').first()).toContainText('Harbor')
  await target.press('Enter')
  const paths = detail.getByRole('region', { name: 'Supported paths' })
  await expect(paths.getByRole('listitem')).toHaveCount(2)
  await expect(paths).toContainText('Rina Okafor owns Harbor ledger.')
  await expect(paths).toContainText('Harbor ledger is part of Harbor.')
  await paths.getByRole('button', { name: 'Highlight route 1', exact: true }).click()
  await expect(
    paths.getByRole('button', { name: 'Highlight route 1', exact: true }),
  ).toHaveAttribute('aria-pressed', 'true')
}

export async function resetBrain(page: Page): Promise<void> {
  const previous = await status(page)
  await page
    .locator('.page-shell-header')
    .getByRole('button', { name: 'Settings', exact: true })
    .click()
  await page.getByRole('button', { name: 'Reset Brain knowledge', exact: true }).click()
  const confirm = page.getByRole('dialog').filter({ has: page.getByPlaceholder('RESET') })
  await confirm.getByPlaceholder('RESET').fill('RESET')
  await confirm.getByRole('button', { name: 'Reset knowledge', exact: true }).click()
  await expect.poll(async () => (await status(page)).counts).toEqual({ memories: 0, entities: 0 })
  expect((await status(page)).generation).not.toBe(previous.generation)
  await page.keyboard.press('Escape')
  await expect(
    page.getByText(
      'No knowledge yet. Right-click a lane and choose Queue for knowledge extraction.',
      { exact: true },
    ),
  ).toBeVisible()
  const graph = await page.evaluate(() => window.phosphor.invoke('brain:overview'))
  expect(graph.nodes).toEqual([])
  expect(graph.links).toEqual([])
  const found = await page.evaluate(() => window.phosphor.invoke('brain:find', 'Harbor', 12))
  expect(found.entities).toEqual([])
  expect(found.memories).toEqual([])
}
