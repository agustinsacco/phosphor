import { expect, type Page } from '@playwright/test'
import type { BrainLane } from './brain-lanes'

export const brainNav = (page: Page) =>
  page
    .getByRole('navigation', { name: 'Main navigation' })
    .getByRole('button', { name: /^Brain(?: \d+ waiting)?$/ })
const laneRow = (page: Page, lane: BrainLane) =>
  page.getByTestId('session-row').filter({ hasText: lane.title }).first()
export const status = (page: Page) => page.evaluate(() => window.phosphor.invoke('brain:status'))
export const changes = (page: Page) =>
  page.evaluate(() => window.phosphor.invoke('brain:tidyChanges', 50))

/** The regions of the one-screen Brain page. */
export const header = (page: Page) => page.locator('.page-shell-header')
export const mapPane = (page: Page) => page.getByRole('region', { name: 'Map', exact: true })
export const card = (page: Page) => page.getByRole('complementary', { name: 'Card', exact: true })
export const cardTitle = (page: Page) => card(page).getByRole('heading', { level: 2 })
export const walk = (page: Page) => page.getByRole('navigation', { name: 'Walk', exact: true })
export const whatChanged = (page: Page) =>
  page.getByRole('region', { name: 'What changed', exact: true })
export const statusBar = (page: Page) => page.getByRole('status', { name: 'Brain status' })
export const defragButton = (page: Page) =>
  header(page).getByRole('button', { name: 'Defrag', exact: true })
/** A line on the map, named by its sentence. */
export const edge = (page: Page, sentence: string) =>
  mapPane(page).locator(`[data-edge][aria-label="${sentence}"]`)
export const mapCentredOn = (page: Page, label: string) =>
  expect(
    mapPane(page).getByRole('group', { name: `Map of ${label} and its neighbours` }),
  ).toBeVisible()

/**
 * A stubbed read spawns four model calls and holds the first for three seconds. A loaded CI
 * runner has taken more than four times as long, so a read gets its own budget, not the default.
 */
export const READ_TIMEOUT = 60_000
/** Brain Agent starts on its own 60 quiet seconds after a saved read; its turn comes after. */
export const AUTO_RUN_TIMEOUT = 150_000

/** A read saves when it finishes: the lane leaves the inbox and counts as read. */
export async function awaitSaved(page: Page, lane: BrainLane): Promise<void> {
  await expect
    .poll(
      async () => {
        const snapshot = await status(page)
        const job = snapshot.jobs.find((j) => j.sessionPath === lane.source)
        return job ? job.state : snapshot.readSessionIds.includes(lane.sessionId) && 'saved'
      },
      { timeout: READ_TIMEOUT },
    )
    .toBe('saved')
}

/**
 * A saved read is followed by background upkeep that may move the revision. Wait until it has
 * held still for a second; the page may still hold the previous revision until it next polls.
 */
export async function awaitSettled(page: Page): Promise<void> {
  let last = -1
  await expect
    .poll(
      async () => {
        const now = (await status(page)).revision
        const still = now === last
        last = now
        return still
      },
      { intervals: [1_000], timeout: READ_TIMEOUT },
    )
    .toBe(true)
}

export async function awaitFailed(page: Page, lane: BrainLane): Promise<void> {
  await expect
    .poll(async () => (await status(page)).jobs.find((j) => j.sessionPath === lane.source)?.state, {
      timeout: READ_TIMEOUT,
    })
    .toBe('failed')
}

/**
 * Turn Brain on in Settings, where the Brain Agent switch replaces review. `agentAuto: false`
 * keeps Brain Agent to Defrag, so a spec decides when it runs.
 */
export async function enableBrain(
  page: Page,
  lane: BrainLane,
  { agentAuto = true }: { agentAuto?: boolean } = {},
): Promise<void> {
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
  const auto = page.getByRole('switch', { name: 'Brain Agent checks new knowledge on its own' })
  await expect(auto).toBeChecked()
  await expect(page.getByRole('switch', { name: 'Review before saving' })).toHaveCount(0)
  if (!agentAuto) {
    await auto.click()
    await expect.poll(async () => (await status(page)).prefs.agentAuto).toBe(false)
  }
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

/** Read again from the lane menu: the confirmation says what it replaces. */
export async function readAgain(page: Page, lane: BrainLane, confirm: boolean): Promise<void> {
  await laneRow(page, lane).click({ button: 'right' })
  await page.getByText('Read again for Brain…', { exact: true }).click()
  const dialog = page.getByRole('dialog', { name: `Read “${lane.title}” again?` })
  await expect(dialog).toContainText('unshared current memories stay until the new result')
  await dialog.getByRole('button', { name: confirm ? 'Read again' : 'Cancel', exact: true }).click()
  await expect(dialog).toHaveCount(0)
}

/** Page keys (`/`, `[` and `]`) belong to the page: focus a node on the map, then press. */
export async function pressOnPage(page: Page, key: string): Promise<void> {
  await mapPane(page).locator('svg [role="button"]').first().focus()
  await page.keyboard.press(key)
}

/** `/` opens Brain search; Enter goes to the first match. */
export async function searchTo(page: Page, name: string): Promise<void> {
  await pressOnPage(page, '/')
  const palette = page.getByRole('dialog', { name: 'Search Brain' })
  const search = palette.getByRole('combobox', { name: 'Find a person, project or memory' })
  await expect(search).toBeFocused()
  await search.fill(name)
  await expect(palette.getByRole('option').first()).toContainText(name)
  await search.press('Enter')
  await expect(palette).toHaveCount(0)
  await expect(cardTitle(page)).toHaveText(name)
}

/** Follow a relationship from the card: the walk gains its sentence. */
export async function walkAlong(page: Page, sentence: string, to: string): Promise<void> {
  await card(page).getByRole('button', { name: sentence, exact: true }).click()
  await expect(cardTitle(page)).toHaveText(to)
  await expect(walk(page).getByRole('listitem').last()).toHaveText(sentence)
}

/** Defrag by hand and wait for Brain Agent's run to finish. */
export async function defrag(page: Page): Promise<void> {
  await defragButton(page).click()
  await expect(statusBar(page)).toContainText(/Brain Agent is defragging|Defrag starts/)
  await expect
    .poll(async () => (await status(page)).agent.run?.state, { timeout: READ_TIMEOUT })
    .toBe('done')
}

/** Nothing on the page scrolls sideways, wide or narrow. */
export async function expectNoSideScroll(page: Page): Promise<void> {
  const original = page.viewportSize() ?? { width: 1280, height: 800 }
  for (const width of [1400, 1000, 700]) {
    await page.setViewportSize({ width, height: original.height })
    await expect
      .poll(
        () =>
          page.locator('.page-shell').evaluate((shell) =>
            [
              shell,
              ...shell.querySelectorAll<HTMLElement>(
                '.brain-screen, .brain-map-pane, .brain-card-pane, .brain-walk, .brain-changes',
              ),
            ]
              .filter((pane) => pane.getBoundingClientRect().width > 0)
              .filter((pane) => pane.scrollWidth > pane.clientWidth + 1)
              .map((pane) => pane.getAttribute('aria-label') ?? pane.className),
          ),
        { message: `Brain fits at ${width}px` },
      )
      .toEqual([])
  }
  await page.setViewportSize(original)
}

export async function resetBrain(page: Page): Promise<void> {
  const previous = await status(page)
  await header(page).getByRole('button', { name: 'Settings', exact: true }).click()
  await page.getByRole('button', { name: 'Reset Brain knowledge', exact: true }).click()
  const confirm = page.getByRole('dialog').filter({ has: page.getByPlaceholder('RESET') })
  await expect(confirm).not.toContainText('review')
  await confirm.getByPlaceholder('RESET').fill('RESET')
  await confirm.getByRole('button', { name: 'Reset knowledge', exact: true }).click()
  await expect.poll(async () => (await status(page)).counts).toEqual({ memories: 0, entities: 0 })
  expect((await status(page)).generation).not.toBe(previous.generation)
  await page.keyboard.press('Escape')
  await expect(
    page.getByText('Brain knows no one yet. It learns from your lanes as they finish.'),
  ).toBeVisible()
  const graph = await page.evaluate(() => window.phosphor.invoke('brain:overview'))
  expect(graph.nodes).toEqual([])
  expect(graph.links).toEqual([])
  const found = await page.evaluate(() => window.phosphor.invoke('brain:find', 'Harbor', 12))
  expect(found.entities).toEqual([])
  expect(found.memories).toEqual([])
}
