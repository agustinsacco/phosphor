import { test, expect, type Page } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launch, shutdown } from './fixtures/local-app'
import type { BrainLane } from './fixtures/brain-lanes'
import { seedBrainLanes } from './fixtures/brain-lanes'
import {
  attachBrainFailure,
  expectGraphFocusClear,
  watchBrainErrors,
  expectBoundedReadText,
} from './fixtures/brain-inspection'
import {
  READ_TIMEOUT,
  awaitFailed,
  awaitSaved,
  brainNav,
  card,
  cardTitle,
  changes,
  defragButton,
  edge,
  enableBrain,
  expectNoSideScroll,
  header,
  mapCentredOn,
  mapPane,
  pressOnPage,
  queueLane,
  readAgain,
  readNewMessages,
  resetBrain,
  searchTo,
  status,
  statusBar,
  walk,
  walkAlong,
  whatChanged,
} from './fixtures/brain-flow'

const OWNS = 'Rina Okafor owns Harbor ledger'
const TOOK_OVER = 'Tom Lee took over Harbor ledger from Rina Okafor'

async function launchBrain(seed: Awaited<ReturnType<typeof seedBrainLanes>>) {
  return launch({
    workspace: seed.workspace,
    agentDir: seed.agent,
    userDataDir: seed.profile,
    env: { PHOSPHOR_BRAIN_TEST_EMBEDDINGS: '1', PHOSPHOR_PI_STUB: seed.wrapper },
  })
}

test('Brain saves a read without review and shows it on one screen: sentences, a walk, you, Ask, retry, read again and reset', async () => {
  // Four reads, one of them failing first: allow each its read budget on a loaded runner.
  test.setTimeout(300_000)
  const seed = await seedBrainLanes()
  const h = await launchBrain(seed)
  const { page } = h
  try {
    await enableBrain(page, seed.harbor, { agentAuto: false })
    const noReadErrors = await watchBrainErrors(page)
    await expectOneScreen(page)
    await queueLane(page, seed.harbor)
    await expect(statusBar(page)).toContainText(`Reading ${seed.harbor.title}`)
    await awaitSaved(page, seed.harbor)
    await noReadErrors()
    const firstJob = await expectSavedRead(page, seed.harbor)
    await expectDirectedLinks(page, firstJob)
    await walkTheMap(page)
    await setOwner(page)
    await askLightsTrail(page)
    await expectNoSideScroll(page)
    await wholeGraph(page)

    await writeFile(seed.armed, 'armed\n')
    await queueLane(page, seed.ledger)
    await awaitFailed(page, seed.ledger)
    const failed = statusBar(page).getByText(seed.ledger.title, { exact: false })
    await expect(failed).toBeVisible()
    await noReadErrors()
    expect(await readFile(join(seed.failureDirectory, 'failed-attempt-2'), 'utf8')).toBe(
      'extract\n',
    )
    await statusBar(page).getByRole('button', { name: 'Retry', exact: true }).click()
    await awaitSaved(page, seed.ledger)
    const combined = await page.evaluate(() => window.phosphor.invoke('brain:overview'))
    const harbor = combined.nodes.filter((e) => e.label === 'Harbor')
    expect(harbor).toHaveLength(1)
    const bridge = combined.nodes.find((e) => e.label === 'Ledger bridge')!
    expect(combined.links).toContainEqual(
      expect.objectContaining({
        subjectId: bridge.id,
        predicate: 'part_of',
        objectId: harbor[0]!.id,
      }),
    )
    await readNewMessages(page, seed.harbor)
    await expect(page.getByText('Nothing new in this lane since its last read.')).toBeVisible()
    await rereadHarbor(page, seed.harbor, firstJob)
    await undoSavedRead(page, seed.harbor)
    await resetBrain(page)
    for (const lane of [seed.harbor, seed.ledger])
      expect(await readFile(lane.source, 'utf8')).toBe(lane.original)
  } catch (error) {
    await attachBrainFailure(page)
    throw error
  } finally {
    await shutdown(h)
  }
})

/** No tabs and no Lanes: the map, the card, the walk, Ask and What changed on one screen. */
async function expectOneScreen(page: Page): Promise<void> {
  await expect(page.getByRole('tablist')).toHaveCount(0)
  await expect(page.getByRole('tab', { name: /^Lanes/ })).toHaveCount(0)
  await expect(page.getByRole('region', { name: 'Brain lanes' })).toHaveCount(0)
  await expect(mapPane(page)).toBeVisible()
  await expect(card(page)).toBeVisible()
  await expect(walk(page)).toBeVisible()
  await expect(page.getByRole('form', { name: 'Ask Brain' })).toBeVisible()
  await expect(whatChanged(page)).toBeVisible()
  await expect(defragButton(page)).toBeDisabled()
}

/** The read saved as one automatic change with Undo; nothing waited for review. */
async function expectSavedRead(page: Page, lane: BrainLane): Promise<string> {
  const snapshot = await status(page)
  expect(snapshot.counts.memories).toBe(lane.facts.length)
  expect(snapshot.jobs.some((job) => job.sessionPath === lane.source)).toBe(false)
  const read = (await changes(page)).items[0]!
  expect(read).toMatchObject({ kind: 'read', who: 'automatic', undoable: true })
  const jobId = read.jobId!
  const row = whatChanged(page).getByRole('listitem').filter({ hasText: read.summary })
  await expect(row).toContainText('Automatic')
  await expect(row.getByRole('button', { name: 'Undo', exact: true })).toBeVisible()
  await row.getByRole('button', { name: /^How .+ was read$/ }).click()
  const record = page.getByRole('dialog', { name: /^How .+ was read$/ })
  await expect(record).toContainText('Read the conversation · part 1')
  await expect(record).not.toContainText('Imaginary')
  await expect(record).not.toContainText(/tokens|stub-model/)
  await page.keyboard.press('Escape')
  await expect(record).toHaveCount(0)
  // Rina Okafor and Mara Voss share two memories and no link: Brain Agent has a pair to settle.
  await expect.poll(async () => (await status(page)).agent.waiting.unlinked).toBe(1)
  await expect(header(page)).toContainText(/\d+ waiting/)
  await defragButton(page).hover()
  await expect(page.getByRole('tooltip')).toContainText('1 unlinked pair')
  return jobId
}

async function expectDirectedLinks(page: Page, jobId: string): Promise<void> {
  const extraction = await page.evaluate(
    (id) => window.phosphor.invoke('brain:extraction', id),
    jobId,
  )
  expect(extraction.calls.map((call) => call.stage)).toEqual([
    'extract',
    'links',
    'identity',
    'reconcile',
  ])
  const linked = JSON.parse(extraction.calls.find((c) => c.stage === 'links')!.answer)
  expect(linked.links).toContainEqual(
    expect.objectContaining({ predicate: 'part_of', quote: 'Harbor ledger is part of Harbor.' }),
  )
  const graph = await page.evaluate(() => window.phosphor.invoke('brain:overview'))
  const id = (label: string) => graph.nodes.find((e) => e.label === label)!.id
  expect(graph.links).toEqual(
    expect.arrayContaining([
      expect.objectContaining({
        subjectId: id('Rina Okafor'),
        predicate: 'owns',
        objectId: id('Harbor ledger'),
      }),
      expect.objectContaining({
        subjectId: id('Harbor ledger'),
        predicate: 'part_of',
        objectId: id('Harbor'),
      }),
      expect.objectContaining({
        subjectId: id('Tom Lee'),
        predicate: 'took_over_from',
        objectId: id('Rina Okafor'),
        label: 'took over Harbor ledger from',
        statedBy: 'reader',
      }),
    ]),
  )
}

/** Every line says its sentence; two steps along them, Back, and `]` forward again. */
async function walkTheMap(page: Page): Promise<void> {
  await searchTo(page, 'Harbor ledger')
  await mapCentredOn(page, 'Harbor ledger')
  const owns = edge(page, OWNS)
  await expect(owns).toBeVisible()
  await owns.hover()
  await expect(mapPane(page).locator('[data-edge-sentence]')).toContainText(OWNS)
  await expect(edge(page, 'Harbor ledger is part of Harbor')).toBeVisible()
  await walkAlong(page, OWNS, 'Rina Okafor')
  await mapCentredOn(page, 'Rina Okafor')
  await expect(edge(page, TOOK_OVER)).toBeVisible()
  await walkAlong(page, TOOK_OVER, 'Tom Lee')
  const steps = await walk(page).getByRole('listitem').allTextContents()
  expect(steps.slice(-3)).toEqual(['Harbor ledger', OWNS, TOOK_OVER])
  // The walk lights the relationships it followed.
  await expect(edge(page, TOOK_OVER)).toHaveAttribute('data-lit', 'true')
  await walk(page).getByRole('button', { name: 'Back', exact: true }).click()
  await expect(cardTitle(page)).toHaveText('Rina Okafor')
  await pressOnPage(page, ']')
  await expect(cardTitle(page)).toHaveText('Tom Lee')
}

/** "This is me" on Mara Voss: the next visit starts the map from her. */
async function setOwner(page: Page): Promise<void> {
  await searchTo(page, 'Mara Voss')
  await card(page).getByRole('button', { name: 'This is me', exact: true }).click()
  await expect(card(page)).toContainText('This is you')
  const snapshot = await status(page)
  const graph = await page.evaluate(() => window.phosphor.invoke('brain:overview'))
  expect(snapshot.ownerId).toBe(graph.nodes.find((e) => e.label === 'Mara Voss')!.id)
  await page.getByRole('button', { name: 'Close page', exact: true }).click()
  await brainNav(page).click()
  await mapCentredOn(page, 'Mara Voss')
  await expect(
    mapPane(page).getByRole('button', { name: /^Mara Voss, .*\(centre\)$/ }),
  ).toBeVisible()
  await expect(cardTitle(page)).toHaveText('Mara Voss')
}

/** Enter asks Brain; the answer takes the card's place and its trail lights on the map. */
async function askLightsTrail(page: Page): Promise<void> {
  const input = page.getByRole('textbox', { name: 'Ask Brain, or tell Brain Agent' })
  await input.fill('What did Tom Lee take over?')
  await input.press('Enter')
  const answer = page.getByRole('region', { name: 'Answer', exact: true })
  await expect(answer).toContainText('Tom Lee took over Harbor ledger from Rina Okafor.')
  // Counted, not checked for a box: a vertical line's box is zero wide.
  await expect(mapPane(page).locator('[data-edge][data-lit="true"]')).not.toHaveCount(0)
  await expect(answer).toContainText(/^.*via .+/)
  await answer.getByRole('button', { name: 'Close', exact: true }).click()
  await expect(answer).toHaveCount(0)
}

/** The 3D whole graph behind the map header's button: a click inspects, Escape clears. */
async function wholeGraph(page: Page): Promise<void> {
  await mapPane(page).getByRole('button', { name: 'Whole graph', exact: true }).click()
  const full = page.getByRole('region', { name: 'Whole graph', exact: true })
  const nodes = full.getByRole('list', { name: 'Graph entities' })
  const count = (await status(page)).counts.entities
  await expect(nodes.getByRole('button')).toHaveCount(count)
  const rina = nodes.getByRole('button', { name: 'Focus Rina Okafor', exact: true })
  // The accessible list is visually hidden; keyboard activation runs the same node action.
  await rina.focus()
  await rina.press('Enter')
  await expect(full.getByRole('complementary', { name: 'Inspector' })).toContainText('Rina Okafor')
  await expectGraphFocusClear(page)
  await page.keyboard.press('Escape')
  await expect(full.getByRole('complementary', { name: 'Inspector' })).toHaveCount(0)
  await rina.focus()
  await rina.press('Enter')
  await full.getByRole('button', { name: 'Go there', exact: true }).click()
  await expect(full).toHaveCount(0)
  await expect(cardTitle(page)).toHaveText('Rina Okafor')
}

async function rereadHarbor(page: Page, lane: BrainLane, earlier: string): Promise<void> {
  await readAgain(page, lane, false)
  const old = await page.evaluate((id) => window.phosphor.invoke('brain:extraction', id), earlier)
  expect(old.prompts.every((p) => !p.startsWith('Prompt not available'))).toBe(true)
  await readAgain(page, lane, true)
  await expect
    .poll(async () => (await changes(page)).items.filter((i) => i.kind === 'read').length, {
      timeout: READ_TIMEOUT,
    })
    .toBe(3)
  await awaitSaved(page, lane)
  const next = (await changes(page)).items.find((i) => i.kind === 'read')!.jobId!
  expect(next).not.toBe(earlier)
  const fresh = await page.evaluate((id) => window.phosphor.invoke('brain:extraction', id), next)
  expect(fresh.memories).toHaveLength(lane.facts.length)
  for (const memory of old.memories) {
    expect(fresh.memories.map((m) => m.id)).not.toContain(memory.id)
    expect(
      await page.evaluate(
        (id) => window.phosphor.invoke('brain:memory', id).catch(String),
        memory.id,
      ),
    ).toContain('Brain memory not found')
  }
}

/** Undo of a saved read rejects it with nothing of its own, and the lane offers Read again. */
async function undoSavedRead(page: Page, lane: BrainLane): Promise<void> {
  const read = (await changes(page)).items.find((i) => i.kind === 'read')!
  const row = whatChanged(page).getByRole('listitem').filter({ hasText: read.summary }).first()
  await row.getByRole('button', { name: 'Undo', exact: true }).click()
  await expect(row).toContainText('undone')
  const after = await page.evaluate(
    (id) => window.phosphor.invoke('brain:laneRead', id),
    lane.sessionId,
  )
  expect(after?.job).toMatchObject({ id: read.jobId, state: 'rejected', memories: 0 })
  await readAgain(page, lane, false)
}

test('Brain reads a queued lane with the reader selected in Settings', async () => {
  const seed = await seedBrainLanes()
  const argvLog = join(seed.workspace, 'brain-argv.jsonl')
  const originalWrapper = await readFile(seed.wrapper, 'utf8')
  await writeFile(
    seed.wrapper,
    `if (process.argv.some(arg => arg.endsWith('brain-fork-guard.mjs'))) require('node:fs').appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n${originalWrapper}`,
  )
  const h = await launchBrain(seed)
  const { page } = h
  try {
    await enableBrain(page, seed.harbor, { agentAuto: false })
    await page
      .getByTestId('account-footer')
      .getByRole('button', { name: 'Settings', exact: true })
      .click()
    await page.getByRole('dialog').getByRole('button', { name: 'Brain', exact: true }).click()
    await expect(page.getByText('Model that reads lanes', { exact: true })).toBeVisible()
    await page.getByTestId('brain-reader-model').click()
    await page.getByTestId('model-search').fill('provider:pi-claude-cli')
    await page.getByTestId('model-row').click()
    await expect
      .poll(async () => (await status(page)).prefs.model)
      .toBe('pi-claude-cli/claude-opus-5')
    await page.keyboard.press('Escape')
    await queueLane(page, seed.harbor)
    await awaitSaved(page, seed.harbor)
    // The page never names the model that read.
    await expect(page.locator('.page-shell')).not.toContainText(/Claude Opus|claude-opus/)
    const launches = (await readFile(argvLog, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[])
    const extract = launches.find((args) =>
      args.some((arg) => /extract-\d+\/system\.md$/.test(arg)),
    )
    expect(extract, 'Brain extract launch').toBeDefined()
    for (const args of launches) {
      expect(args[args.indexOf('--model') + 1]).toBe('pi-claude-cli/claude-opus-5')
      expect(args[args.indexOf('--thinking') + 1]).toBe('medium')
    }
    expect(await readFile(seed.harbor.source, 'utf8')).toBe(seed.harbor.original)
  } finally {
    await shutdown(h)
  }
})

test('Brain journals a card edit with Undo in What changed', async () => {
  const seed = await seedBrainLanes()
  const h = await launchBrain(seed)
  const { page } = h
  try {
    await enableBrain(page, seed.harbor, { agentAuto: false })
    await queueLane(page, seed.harbor)
    await awaitSaved(page, seed.harbor)
    await searchTo(page, 'Rina Okafor')
    await card(page).getByRole('button', { name: 'More actions' }).click()
    await page.getByText('Edit description…', { exact: true }).click()
    const description = page.getByRole('dialog', { name: 'Describe Rina Okafor' })
    await description.getByRole('textbox', { name: 'Description' }).fill('Harbor ledger owner')
    await description.getByRole('button', { name: 'Save', exact: true }).click()
    await expect(card(page)).toContainText('Harbor ledger owner')
    const row = whatChanged(page).getByRole('listitem').filter({ hasText: 'By you' }).first()
    await expect(row).toBeVisible()
    await row.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect(row).toContainText('undone')
    await expect(card(page)).not.toContainText('Harbor ledger owner')
  } finally {
    await shutdown(h)
  }
})

test('Brain caps long read output, prompts and source text in how it was read', async () => {
  const seed = await seedBrainLanes()
  const h = await launchBrain(seed)
  const { page } = h
  try {
    await enableBrain(page, seed.harbor, { agentAuto: false })
    await queueLane(page, seed.harbor)
    await awaitSaved(page, seed.harbor)
    const jobId = (await changes(page)).items.find((i) => i.kind === 'read')!.jobId!
    const record = await page.evaluate(
      (id) => window.phosphor.invoke('brain:extraction', id),
      jobId,
    )
    record.calls = [{ ...record.calls[0]!, answer: 'Harbor output\n'.repeat(1500) }]
    record.prompts = ['Ledger prompt\n'.repeat(1500)]
    record.source.segments = [
      {
        entryId: 'harbor-entry',
        role: 'user',
        observedAt: 0,
        label: 'user · 2026-11-01T00:00:00Z',
        text: 'Kestrel source\n'.repeat(1500),
      },
    ]
    await h.app.evaluate(({ ipcMain }, value) => {
      ipcMain.removeHandler('brain:extraction')
      ipcMain.handle('brain:extraction', () => value)
    }, record)
    await whatChanged(page)
      .getByRole('button', { name: /^How .+ was read$/ })
      .first()
      .click()
    await expectBoundedReadText(page)
  } finally {
    await shutdown(h)
  }
})
