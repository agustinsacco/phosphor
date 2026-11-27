import type { Page } from '@playwright/test'
import { BRAIN_GENERATION, OVERLAP_LANE } from './brain-host'
import { browserFixture, expect, test as base } from './fixture'

const test = base.extend<{ brainWorld: BrainWorld }>({
  // eslint-disable-next-line no-empty-pattern
  brainWorld: async ({}, use) => {
    const world = await browserFixture(false, true)
    try {
      await use(world)
    } finally {
      await world.close()
    }
  },
})

type BrainWorld = Awaited<ReturnType<typeof browserFixture>>

function brainHosts(world: BrainWorld) {
  if (!('brainHosts' in world)) throw Error('The Brain world has no fixture Hosts')
  return world.brainHosts
}

const READ = 'View knowledge and search Brain'
const CONTROL = 'Stop Brain Agent’s running turn'
const EVIDENCE = 'Read memory evidence and source excerpts'
const CONFIGURE = 'Configure Brain and change knowledge'
const ACCESS = 'Brain access'
const APPLY = 'Apply Brain access'

async function openBrain(page: Page, origin: string) {
  await page.goto(origin)
  await page.getByRole('button', { name: 'Sign in with GitHub' }).click()
  await expect(page.locator('html')).toHaveAttribute('data-form-factor', 'compact')
  await page
    .getByRole('navigation', { name: 'Tabs' })
    .getByRole('button', { name: 'Brain' })
    .click()
  return page.getByRole('combobox', { name: 'Brain Host' })
}

async function grant(page: Page, ...rights: string[]) {
  await expect(page.getByRole('button', { name: ACCESS, exact: true })).toHaveAttribute(
    'aria-expanded',
    'true',
  )
  for (const right of rights) await page.getByRole('checkbox', { name: right }).check()
  await page.getByRole('button', { name: APPLY }).click()
}

function tab(page: Page, name: string) {
  return page.getByRole('navigation', { name: 'Tabs' }).getByRole('button', { name }).click()
}

function memory(page: Page, label: string) {
  return page.getByRole('button', { name: `${label} memory`, exact: true })
}

test('compact Brain isolates colliding Host data, permissions, evidence and one-use approvals', async ({
  page,
  brainWorld,
}) => {
  const [harbor, ledger] = brainHosts(brainWorld)
  const pick = await openBrain(page, brainWorld.origin)
  await pick.selectOption(harbor.id)
  await expect(page.getByText('You do not have access to this Host’s Brain.')).toBeVisible()
  await grant(page, READ, EVIDENCE)
  const oldEvidence = harbor.holdEvidence()
  try {
    await memory(page, 'Harbor').click()
    await expect.poll(harbor.evidenceCalls).toBe(1)
    await page.getByRole('button', { name: 'Close', exact: true }).click()
    await pick.selectOption(ledger.id)
    await expect(page.getByText('You do not have access to this Host’s Brain.')).toBeVisible()
    // Brain Agent's conversation and its approvals take every Brain right.
    await grant(page, READ, CONTROL, EVIDENCE, CONFIGURE)
    await page.getByRole('button', { name: 'Knowledge', exact: true }).click()
    await memory(page, 'Ledger').click()
    await expect(page.getByText('Ledger evidence', { exact: true })).toBeVisible()
    oldEvidence()
    await expect(page.getByText('Harbor evidence', { exact: true })).toHaveCount(0)
    // Even though both Hosts expose this exact lane ID, only Ledger's route may open.
    await page.getByRole('button', { name: 'Open source lane' }).click()
    await expect(page).toHaveURL(`${brainWorld.origin}/lanes/${ledger.id}/${OVERLAP_LANE}/chat`)
    await expect(page.getByText('Ledger source transcript', { exact: true })).toBeVisible()
    await expect(page.getByText('Harbor source transcript', { exact: true })).toHaveCount(0)
    await page.goBack()
    await page.getByRole('button', { name: 'Knowledge', exact: true }).click()
    await expect(memory(page, 'Ledger')).toBeVisible()
  } finally {
    oldEvidence()
  }

  // Harbor's separate older lane still exists; a stale Ledger ref must NOT route there.
  ledger.staleSource()
  await memory(page, 'Ledger').click()
  await expect(page.getByText('Ledger evidence', { exact: true })).toBeVisible()
  await expect(page.getByRole('button', { name: 'Open source lane' })).toBeDisabled({
    timeout: 3000,
  })
  await page.getByRole('button', { name: 'Close', exact: true }).click()

  const harborAsk = await harbor.ask('Harbor approval')
  const ledgerAsk = await ledger.ask('Ledger approval')
  await page.getByRole('button', { name: 'Approve once' }).click()
  expect(await harborAsk.status()).toMatchObject({ status: 'ok', data: { state: 'pending' } })
  expect(await ledgerAsk.redeem()).toMatchObject({ status: 'ok' })
  expect(await ledgerAsk.redeem()).toMatchObject({ status: 'denied' })
  expect(ledger.commands).toEqual(['Ledger approval'])
  expect(harbor.commands).toEqual([])
  await page.getByRole('button', { name: 'Conversation', exact: true }).click()
  await expect(page.getByText('Ledger transcript', { exact: true })).toBeVisible()

  await page.getByRole('button', { name: ACCESS, exact: true }).click()
  await page.getByRole('checkbox', { name: CONTROL }).uncheck()
  await page.getByRole('checkbox', { name: READ }).uncheck()
  await page.getByRole('button', { name: APPLY }).click()
  await expect(page.getByText('You do not have access to this Host’s Brain.')).toBeVisible()
  await expect(page.getByText('Ledger transcript', { exact: true })).toHaveCount(0)
  await pick.selectOption(harbor.id)
  await expect(memory(page, 'Harbor')).toBeVisible()
  const restore = brainWorld.holdHost()
  try {
    await expect(memory(page, 'Harbor')).toHaveCount(0)
  } finally {
    restore()
  }
  await expect(memory(page, 'Harbor')).toBeVisible()
  await pick.selectOption(ledger.id)
  await expect(page.getByText('You do not have access to this Host’s Brain.')).toBeVisible()
})

test('compact Host graph walks relationship sentences, changes hops and compares paths', async ({
  page,
  brainWorld,
}) => {
  const [harbor] = brainHosts(brainWorld)
  const pick = await openBrain(page, brainWorld.origin)
  await pick.selectOption(harbor.id)
  await grant(page, READ)
  const graph = page.getByRole('region', { name: 'Knowledge graph' })
  const card = graph.getByRole('region', { name: 'Card' })
  await expect(card.getByRole('heading', { name: 'Mara Voss' })).toBeVisible()
  await card.getByRole('button', { name: 'Tom Lee reports to Mara Voss' }).click()
  await expect(card.getByRole('heading', { name: 'Tom Lee' })).toBeVisible()
  const walk = graph.getByRole('navigation', { name: 'Walk' })
  await expect(walk).toContainText('Tom Lee reports to Mara Voss')
  await walk.getByRole('button', { name: 'Back', exact: true }).click()
  await expect(card.getByRole('heading', { name: 'Mara Voss' })).toBeVisible()
  await walk.getByRole('button', { name: 'Forward', exact: true }).click()
  await expect(card.getByRole('heading', { name: 'Tom Lee' })).toBeVisible()
  await graph.getByRole('button', { name: '2 steps', exact: true }).click()
  await card.getByRole('button', { name: 'Connects to…' }).click()
  await card.getByRole('searchbox', { name: 'Find route target' }).fill('Mara')
  await card.getByRole('button', { name: 'Mara Voss', exact: true }).click()
  const routes = card.getByRole('region', { name: 'Routes' })
  await expect(routes).toContainText('Tom Lee reports to Mara Voss')
  await routes.getByRole('button', { name: 'Show on the map' }).click()
  await expect(graph.locator('[data-edge-sentence]')).toHaveText('Tom Lee reports to Mara Voss')
})

test('a compact Host lane menu queues that lane once on its own Host, and not after a disconnect or revoke', async ({
  page,
  brainWorld,
}) => {
  const [harbor, ledger] = brainHosts(brainWorld)
  const pick = await openBrain(page, brainWorld.origin)
  await pick.selectOption(harbor.id)
  await grant(page, READ, CONFIGURE)
  await expect(page.getByRole('heading', { name: 'Mara Voss' })).toBeVisible()
  await tab(page, 'Home')
  // Both Hosts list a lane with this exact ID; listing them reads no Brain state.
  const harborRow = page.getByTestId('remote-session-row').filter({ hasText: 'Harbor source lane' })
  const ledgerRow = page.getByTestId('remote-session-row').filter({ hasText: 'Ledger source lane' })
  await expect(harborRow).toBeVisible()
  await expect(ledgerRow).toBeVisible()
  expect([...harbor.laneReads, ...ledger.laneReads]).toEqual([])

  const sheet = page.getByTestId('context-menu-sheet')
  const queue = sheet.getByRole('button', { name: 'Queue for knowledge extraction', exact: true })
  await harborRow.click({ button: 'right' })
  await queue.click()
  await expect.poll(() => harbor.queued.length).toBe(1)
  expect(harbor.queued).toEqual([
    { laneId: OVERLAP_LANE, expected: { generation: BRAIN_GENERATION, revision: 0 } },
  ])
  expect(harbor.laneReads).toEqual([OVERLAP_LANE])
  await expect(sheet).toHaveCount(0)

  // Ledger granted no Brain access here: its row reads nothing and offers no queue.
  await ledgerRow.click({ button: 'right' })
  await expect(sheet.getByRole('button', { name: 'Archive' })).toBeVisible()
  await expect(queue).toHaveCount(0)
  await sheet.getByRole('button', { name: 'Cancel', exact: true }).click()
  expect(ledger.laneReads).toEqual([])

  // A disconnect after the item showed takes it away and writes nothing.
  await harborRow.click({ button: 'right' })
  await expect(queue).toBeVisible()
  const restore = brainWorld.holdHost()
  try {
    await expect(queue).toHaveCount(0)
  } finally {
    restore()
  }
  if (await sheet.count()) await sheet.getByRole('button', { name: 'Cancel', exact: true }).click()

  await tab(page, 'Brain')
  await pick.selectOption(harbor.id)
  await page.getByRole('button', { name: ACCESS, exact: true }).click()
  await page.getByRole('checkbox', { name: CONFIGURE }).uncheck()
  await page.getByRole('button', { name: APPLY }).click()
  await tab(page, 'Home')
  await harborRow.click({ button: 'right' })
  await expect(sheet.getByRole('button', { name: 'Archive' })).toBeVisible()
  await expect(queue).toHaveCount(0)
  await expect(sheet.getByRole('button', { name: 'Brain read…', exact: true })).toHaveCount(0)
  expect(harbor.queued).toHaveLength(1)
  expect(ledger.queued).toEqual([])
})

for (const width of [400, 1280]) {
  test(`selected Host's saved conversation and knowledge search are separate at ${width}px`, async ({
    page,
    brainWorld,
  }) => {
    const [harbor, ledger] = brainHosts(brainWorld)
    await page.setViewportSize({ width, height: 850 })
    await page.goto(brainWorld.origin)
    await page.getByRole('button', { name: 'Sign in with GitHub' }).click()
    await page.goto(`${brainWorld.origin}/pages/brain/${harbor.id}`)
    const pick = page.getByRole('combobox', { name: 'Brain Host' })
    await grant(page, READ, CONTROL, EVIDENCE, CONFIGURE)
    const transcript = page.getByRole('list', { name: 'Transcript' })
    await expect(transcript).toContainText('Harbor transcript')
    await expect(page.getByText('Read-only. This Host can’t send messages yet.')).toBeVisible()
    await expect(page.getByRole('textbox', { name: 'Message for Brain Agent' })).toHaveCount(0)
    await expect(page.getByRole('button', { name: 'Send', exact: true })).toHaveCount(0)

    await page.getByRole('button', { name: 'Conversation', exact: true }).focus()
    await page.keyboard.press('/')
    const search = page.getByRole('searchbox', { name: 'Find in Brain' })
    await expect(search).toBeFocused()
    await expect(transcript).toBeHidden()
    await search.fill('Mara')
    await search.press('Enter')
    await expect(page.getByRole('region', { name: 'Search Brain', exact: true })).toContainText(
      'Mara Voss',
    )
    await expect(page.getByRole('button', { name: 'Tell Brain Agent' })).toHaveCount(0)
    await page.getByRole('button', { name: 'Conversation', exact: true }).click()
    await expect(transcript).toContainText('Harbor transcript')
    expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(
      width,
    )

    const restore = brainWorld.holdHost()
    try {
      await expect(transcript).toHaveCount(0)
      await expect(page.getByText('Connecting to this Host…')).toBeVisible()
      await expect(pick).toHaveValue(harbor.id)
    } finally {
      restore()
    }
    await expect(transcript).toContainText('Harbor transcript')
    await pick.selectOption(ledger.id)
    await expect(transcript).toHaveCount(0)
    await expect(page.getByText('You do not have access to this Host’s Brain.')).toBeVisible()
    await grant(page, READ, CONTROL, EVIDENCE, CONFIGURE)
    await expect(transcript).toContainText('Ledger transcript')
    await expect(transcript).not.toContainText('Harbor transcript')
  })
}
