import { expect, type Locator, type Page } from '@playwright/test'
import type { BrainLane } from './brain-lanes'

export const brainNav = (page: Page) =>
  page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: /^Brain(?: \d+ waiting)?$/ })
const laneRow = (page: Page, lane: BrainLane) =>
  page.getByTestId('session-row').filter({ hasText: lane.title }).first()
/** A Brain list row names its lane or subject first, then one line about it. */
const titled = (page: Page, scope: Locator, title: string) =>
  scope.getByRole('button').filter({ has: page.getByText(title, { exact: true }) })
/** A read waiting for Brain Agent, on Lanes. */
export const waitingRow = (page: Page, lane: BrainLane) => readRow(page, lane, 'Waiting for Defrag')
/** A lane's read on the Lanes tab, in one state group. */
export const readRow = (
  page: Page,
  lane: BrainLane,
  group: 'Waiting for Defrag' | 'Reading' | 'Queued' | 'Failed' | 'Read',
) =>
  titled(
    page,
    page
      .getByRole('region', { name: 'Brain lanes', exact: true })
      .getByRole('region', { name: group, exact: true }),
    lane.title,
  )
export const brainTab = (page: Page, name: 'Knowledge' | 'Lanes') =>
  page
    .getByRole('tablist', { name: 'Brain views' })
    .getByRole('tab', { name: new RegExp(`^${name}`) })
export const status = (page: Page) => page.evaluate(() => window.phosphor.invoke('brain:status'))

/**
 * A stubbed read spawns four model calls and holds the first for three seconds. A loaded CI
 * runner has taken more than four times as long, so a read gets its own budget, not the default.
 */
export const READ_TIMEOUT = 60_000
/** Wait for the read of one lane, or of the first job when no lane is named, to settle. */
export async function awaitRead(
  page: Page,
  lane: BrainLane | null,
  state: 'review' | 'failed' = 'review',
): Promise<void> {
  await expect
    .poll(
      async () => {
        const { jobs } = await status(page)
        return (lane ? jobs.find((job) => job.sessionPath === lane.source) : jobs[0])?.state
      },
      { timeout: READ_TIMEOUT },
    )
    .toBe(state)
}

export async function enableBrain(page: Page, lane: BrainLane): Promise<void> {
  const row = laneRow(page, lane)
  await expect(row).toBeVisible({ timeout: 30_000 })
  await expect(brainNav(page)).toHaveCount(0)
  await row.click({ button: 'right' })
  await expect(page.getByText('Queue for knowledge extraction')).toHaveCount(0)
  await page.keyboard.press('Escape')
  await page.getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: /^Brain(?: \d+ waiting)?$/ }).click()
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

/** A lane Brain has read before offers its new messages instead of a first read. */
export async function readNewMessages(page: Page, lane: BrainLane): Promise<void> {
  await laneRow(page, lane).click({ button: 'right' })
  await page.getByText('Read new messages for Brain', { exact: true }).click()
}

export const defragButton = (page: Page) =>
  page.locator('.page-shell-header').getByRole('button', { name: 'Defrag', exact: true })
export const runStrip = (page: Page) =>
  page.getByRole('status').filter({ hasText: /Brain Agent|Defrag starts/ })

/** Inspect the stored read, then ask the ordinary Brain lane to decide it through the bridge. */
export async function defragRead(page: Page, lane: BrainLane): Promise<string> {
  await brainTab(page, 'Lanes').click()
  await awaitRead(page, lane)
  await expect(waitingRow(page, lane)).toContainText('2 memories')
  const job = (await status(page)).jobs.find((job) => job.sessionPath === lane.source)!
  await waitingRow(page, lane).click()
  const waiting = page.getByRole('article', { name: 'Waiting read', exact: true })
  await expect(waiting.getByRole('heading', { name: lane.title, exact: true })).toBeVisible()
  await expect(waiting).not.toContainText('Imaginary')
  for (const fact of lane.facts)
    await expect(waiting.getByText(fact, { exact: true }).first()).toBeVisible()
  await expect(waiting.getByRole('button', { name: /^Approve|^Reject/ })).toHaveCount(0)
  await defragButton(page).click()
  await expect(runStrip(page)).toContainText('Brain Agent is defragging')
  await expect
    .poll(async () => (await status(page)).agent.run?.state, { timeout: READ_TIMEOUT })
    .toBe('done')
  await expect(runStrip(page)).toContainText('Brain Agent decided 1 thing')
  return job.id
}

export async function exploreBrain(page: Page): Promise<void> {
  await brainTab(page, 'Knowledge').click()
  await page.keyboard.press('/')
  const search = page.getByRole('combobox', { name: 'Search people, things, memories' })
  await expect(search).toBeFocused()
  await search.fill('Harbor')
  await expect(page.getByRole('option').first()).toContainText('Harbor')
  await search.press('Enter')
  const profile = page.getByRole('region', { name: 'Profile', exact: true })
  await expect(profile.getByRole('heading', { name: 'Harbor', exact: true })).toBeVisible()
  await walkConnection(page, profile, 'Harbor ledger')
  await expect(profile.getByRole('heading', { name: 'Harbor ledger', exact: true })).toBeVisible()
  await profile.getByRole('tab', { name: /^Memories/ }).click()
  await expect(profile.getByRole('region', { name: 'Memories', exact: true })).toContainText(
    'Rina Okafor owns Harbor ledger.',
  )
  await walkConnection(page, profile, 'Rina Okafor')
  await expect(profile.getByRole('heading', { name: 'Rina Okafor', exact: true })).toBeVisible()
  const trail = page.getByRole('navigation', { name: 'Brain trail' })
  await trail.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(profile.getByRole('heading', { name: 'Harbor ledger', exact: true })).toBeVisible()
  await trail.getByRole('button', { name: 'Forward', exact: true }).click()
  await expect(profile.getByRole('heading', { name: 'Rina Okafor', exact: true })).toBeVisible()
  await profile.getByRole('button', { name: 'Find route…', exact: true }).click()
  const target = profile.getByRole('combobox', { name: 'Find a person or thing' })
  await target.fill('Harbor')
  await expect(profile.getByRole('option').first()).toContainText('Harbor')
  await target.press('Enter')
  const routes = profile.getByRole('region', { name: 'Supported routes' })
  await expect(routes.getByRole('listitem')).toHaveCount(2)
  await expect(routes).toContainText('Rina Okafor owns Harbor ledger.')
  await expect(routes).toContainText('Harbor ledger is part of Harbor.')
  await routes.getByRole('button', { name: 'Show route 1 on the map', exact: true }).click()
  const full = page.getByRole('region', { name: 'Full map', exact: true })
  const nodes = full.getByRole('list', { name: 'Graph entities' })
  for (const name of ['Rina Okafor', 'Harbor ledger', 'Harbor'])
    await expect(nodes.getByRole('button', { name: `Focus ${name}`, exact: true })).toHaveCount(1)
  await full.getByRole('button', { name: 'Back to profile', exact: true }).click()
  await expect(profile.getByRole('heading', { name: 'Rina Okafor', exact: true })).toBeVisible()
}

/** Walk to a neighbour from the profile's Connections tab. */
async function walkConnection(page: Page, profile: Locator, name: string): Promise<void> {
  await profile.getByRole('tab', { name: /^Connections/ }).click()
  await titled(page, profile.getByRole('table', { name: 'Connections', exact: true }), name).click()
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
  await brainTab(page, 'Knowledge').click()
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
