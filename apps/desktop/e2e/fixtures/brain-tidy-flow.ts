import { expect, type Page } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { seedBrainLanes, type BrainLane } from './brain-lanes'
import { awaitRead, inbox, queueLane } from './brain-flow'

export async function seedBrainTidyLanes() {
  const seed = await seedBrainLanes()
  const rename = (text: string) =>
    text.replaceAll('Tom Lee owns Ledger bridge.', 'Rina owns Harbor ledger.')
  seed.ledger.original = rename(seed.ledger.original)
  seed.ledger.facts = seed.ledger.facts.map(rename)
  await writeFile(seed.ledger.source, seed.ledger.original)
  return seed
}

export async function readTidyLane(page: Page, lane: BrainLane): Promise<void> {
  await queueLane(page, lane)
  await page.getByRole('tab', { name: /^Lanes/ }).click()
  await awaitRead(page, lane)
  await inbox(page, lane).click()
  const review = page.getByRole('region', { name: 'Review memories', exact: true })
  for (const fact of lane.facts)
    await expect(review.getByText(fact, { exact: true }).first()).toBeVisible()
  await review.getByRole('button', { name: 'Approve 2', exact: true }).click()
  await expect(review).toHaveCount(0)
}

export async function openTidyNotice(page: Page, count: number): Promise<void> {
  await page.getByRole('tab', { name: 'Knowledge', exact: true }).click()
  await page.getByTestId('notifications-button').click()
  const drawer = page.getByRole('complementary', { name: 'Notifications' })
  const notice = drawer.getByRole('button', {
    name: `Open Tidy: Brain has ${count} things to tidy`,
    exact: true,
  })
  await expect(notice).toHaveCount(1)
  await expect(drawer.getByText(/^Brain has \d+ things to tidy$/)).toHaveCount(1)
  await notice.click()
  await expect(page.getByRole('tab', { name: /^Tidy/ })).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('button', { name: 'Close notifications', exact: true }).click()
}

export async function mergeSwapAndUndo(page: Page): Promise<void> {
  const detail = page.getByRole('article', { name: 'Tidy suggestion', exact: true })
  const initial = await detail.getByRole('button', { name: /^Merge into / }).textContent()
  await detail.getByRole('button', { name: 'Swap surviving record', exact: true }).click()
  const swapped = detail.getByRole('button', { name: /^Merge into / })
  await expect(swapped).not.toHaveText(initial!)
  const survivor = (await swapped.textContent())!.replace('Merge into ', '')
  await swapped.click()
  const recent = page.getByRole('region', { name: 'Recent changes', exact: true })
  await expect(recent).toContainText('Merged two people or things')
  await page.getByRole('tab', { name: 'Knowledge', exact: true }).click()
  const nodes = page.getByRole('list', { name: 'Graph entities' })
  await expect(nodes.getByRole('button', { name: `Focus ${survivor}`, exact: true })).toHaveCount(1)
  await expect(nodes.getByRole('button', { name: /^Focus Rina(?: Okafor)?$/ })).toHaveCount(1)
  await page.getByRole('tab', { name: /^Tidy/ }).click()
  await recent.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(recent).toContainText('Undone')
  await page.getByRole('tab', { name: 'Knowledge', exact: true }).click()
  await expect(nodes.getByRole('button', { name: 'Focus Rina', exact: true })).toHaveCount(1)
  await expect(nodes.getByRole('button', { name: 'Focus Rina Okafor', exact: true })).toHaveCount(1)
}
