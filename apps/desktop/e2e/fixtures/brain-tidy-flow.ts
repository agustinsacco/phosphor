import { expect, type Page } from '@playwright/test'
import { writeFile } from 'node:fs/promises'
import { seedBrainLanes, type BrainLane } from './brain-lanes'
import { awaitRead, brainTab, queueLane, reviewRow } from './brain-flow'

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
  await brainTab(page, 'Inbox').click()
  await awaitRead(page, lane)
  await reviewRow(page, lane).click()
  const review = page.getByRole('article', { name: 'Review memories', exact: true })
  for (const fact of lane.facts)
    await expect(review.getByText(fact, { exact: true }).first()).toBeVisible()
  await review.getByRole('button', { name: 'Approve 2', exact: true }).click()
  await expect(review).toHaveCount(0)
}

export async function openTidyNotice(page: Page, count: number): Promise<void> {
  await brainTab(page, 'Knowledge').click()
  await page.getByTestId('notifications-button').click()
  const drawer = page.getByRole('complementary', { name: 'Notifications' })
  const notice = drawer.getByRole('button', {
    name: `Open Brain Inbox: Brain has ${count} ${count === 1 ? 'thing' : 'things'} to tidy`,
    exact: true,
  })
  await expect(notice).toHaveCount(1)
  await expect(drawer.getByText(/^Brain has \d+ things? to tidy$/)).toHaveCount(1)
  await notice.click()
  await expect(brainTab(page, 'Inbox')).toHaveAttribute('aria-selected', 'true')
  await page.getByRole('button', { name: 'Close notifications', exact: true }).click()
}

/** Merge into the side Brain did not suggest, check the index, then undo from Lanes. */
export async function mergeOtherAndUndo(page: Page): Promise<void> {
  const detail = page.getByRole('article', { name: 'Tidy suggestion', exact: true })
  const suggested = (await detail.getByRole('button', { name: /^Merge into / }).textContent())!
  const other = detail.getByRole('button', { name: /^Keep .+ instead$/ })
  const survivor = (await other.textContent())!.replace(/^Keep (.+) instead$/, '$1')
  expect(suggested).not.toBe(`Merge into ${survivor}`)
  await other.click()
  await brainTab(page, 'Lanes').click()
  const recent = page.getByRole('region', { name: 'Recent changes', exact: true })
  await expect(recent).toContainText('Merged two people or things')
  await brainTab(page, 'Knowledge').click()
  const index = page.getByRole('listbox', { name: 'People and things', exact: true })
  const named = (name: string | RegExp) =>
    index.getByRole('option', {
      name: new RegExp(`^${typeof name === 'string' ? name : name.source}(?: \\d+ memories)?$`),
    })
  await expect(named(survivor)).toHaveCount(1)
  await expect(named(/Rina(?: Okafor)?/)).toHaveCount(1)
  await brainTab(page, 'Lanes').click()
  await recent.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(recent).toContainText('Undone')
  await brainTab(page, 'Knowledge').click()
  await expect(named('Rina')).toHaveCount(1)
  await expect(named('Rina Okafor')).toHaveCount(1)
}
