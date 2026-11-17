import {
  seedBrainTidyLanes,
  readTidyLane,
  openTidyNotice,
  mergeSwapAndUndo,
} from './fixtures/brain-tidy-flow'
import { test, expect, type Page } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launch, shutdown } from './fixtures/local-app'
import type { BrainLane } from './fixtures/brain-lanes'
import { seedBrainLanes } from './fixtures/brain-lanes'
import {
  attachBrainFailure,
  expectGraphFocusClear,
  expectReviewOutcomeAligned,
  watchBrainErrors,
  expectBoundedReadText,
  expectReviewBarAtBottom,
} from './fixtures/brain-inspection'
import {
  approveLane,
  READ_TIMEOUT,
  awaitRead,
  enableBrain,
  exploreBrain,
  inbox,
  queueLane,
  resetBrain,
  status,
} from './fixtures/brain-flow'

test('Brain v4 reviews directed links, explores across lanes, retries and resets without changing lane files', async () => {
  // Four reads, one of them failing first: allow each its read budget on a loaded runner.
  test.setTimeout(300_000)
  const seed = await seedBrainLanes()
  const h = await launch({
    workspace: seed.workspace,
    agentDir: seed.agent,
    userDataDir: seed.profile,
    env: { PHOSPHOR_BRAIN_TEST_EMBEDDINGS: '1', PHOSPHOR_PI_STUB: seed.wrapper },
  })
  const { page } = h
  try {
    await enableBrain(page, seed.harbor)
    const noReadErrors = await watchBrainErrors(page)
    await queueLane(page, seed.harbor)
    await page.getByRole('tab', { name: /^Lanes/ }).click()
    await expect(inbox(page, seed.harbor)).toContainText('Read the conversation')
    await awaitRead(page, null)
    await noReadErrors()
    expect((await status(page)).counts).toEqual({ memories: 0, entities: 0 })
    const firstJob = await approveLane(page, seed.harbor)
    await expect.poll(async () => (await status(page)).counts).toEqual({ memories: 2, entities: 3 })
    await expect(page.getByRole('region', { name: 'Extraction detail' })).toBeVisible()
    await noReadErrors()
    const harbor = await directedGraph(page, firstJob)
    await graphSelection(page)
    await exploreBrain(page)

    await writeFile(seed.armed, 'armed\n')
    await queueLane(page, seed.ledger)
    await page.getByRole('tab', { name: /^Lanes/ }).click()
    await awaitRead(page, seed.ledger, 'failed')
    await inbox(page, seed.ledger).click()
    const failed = page.getByRole('region', { name: 'Failed read', exact: true })
    await expect(failed.getByRole('button', { name: 'Retry', exact: true })).toBeVisible()
    const failedJob = (await status(page)).jobs.find(
      (job) => job.sessionPath === seed.ledger.source,
    )!
    expect(failedJob.state).toBe('failed')
    await expect(failed.getByText('Source lane at extraction')).toBeVisible()
    await noReadErrors()
    expect(await readFile(join(seed.failureDirectory, 'failed-attempt-2'), 'utf8')).toBe(
      'extract\n',
    )
    await failed.getByRole('button', { name: 'Retry', exact: true }).click()
    expect(await approveLane(page, seed.ledger)).toBe(failedJob.id)
    await expect.poll(async () => (await status(page)).counts).toEqual({ memories: 4, entities: 5 })
    const combined = await page.evaluate(() => window.phosphor.invoke('brain:overview'))
    expect(combined.nodes.filter((e) => e.label === 'Harbor').map((e) => e.id)).toEqual([harbor.id])
    const bridge = combined.nodes.find((e) => e.label === 'Ledger bridge')!
    expect(combined.links).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          subjectId: bridge.id,
          predicate: 'part_of',
          objectId: harbor.id,
        }),
      ]),
    )
    await queueLane(page, seed.harbor)
    await expect(
      page.getByText('Nothing new in this lane since its last extraction.'),
    ).toBeVisible()
    await rereadHarbor(page, seed.harbor, firstJob)
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

async function directedGraph(page: Page, firstJob: string) {
  const extraction = await page.evaluate(
    (id) => window.phosphor.invoke('brain:extraction', id),
    firstJob,
  )
  expect(extraction.calls.map((call) => call.stage)).toEqual([
    'extract',
    'links',
    'identity',
    'reconcile',
  ])
  const extracted = JSON.parse(extraction.calls.find((c) => c.stage === 'extract')!.answer)
  expect(extracted.claims[1].links).toEqual([])
  const linked = JSON.parse(extraction.calls.find((c) => c.stage === 'links')!.answer)
  expect(linked.links).toContainEqual(
    expect.objectContaining({ predicate: 'part_of', quote: 'Harbor ledger is part of Harbor.' }),
  )
  const graph = await page.evaluate(() => window.phosphor.invoke('brain:overview'))
  const harbor = graph.nodes.find((e) => e.label === 'Harbor')!
  const rina = graph.nodes.find((e) => e.label === 'Rina Okafor')!
  const ledger = graph.nodes.find((e) => e.label === 'Harbor ledger')!
  const neighbourhood = await page.evaluate(
    (id) => window.phosphor.invoke('brain:neighbourhood', id, 2),
    rina.id,
  )
  expect(neighbourhood.links).toEqual(
    expect.arrayContaining([
      expect.objectContaining({ subjectId: rina.id, predicate: 'owns', objectId: ledger.id }),
      expect.objectContaining({
        subjectId: ledger.id,
        predicate: 'part_of',
        objectId: harbor.id,
      }),
    ]),
  )
  return harbor
}

async function rereadHarbor(page: Page, lane: BrainLane, earlier: string): Promise<void> {
  const history = page.getByRole('region', { name: 'Read', exact: true })
  const row = history.getByRole('button', { name: lane.title, exact: true })
  await expect(row).toContainText('2 memories')
  await row.click()
  await page
    .getByRole('region', { name: 'Extraction detail', exact: true })
    .getByRole('button', { name: 'Read again', exact: true })
    .click()
  const confirm = page.getByRole('dialog', { name: `Read “${lane.title}” again?` })
  await expect(confirm).toContainText('The 2 memories from the earlier read stay until you approve')
  await confirm.getByRole('button', { name: 'Cancel', exact: true }).click()
  await row.click()
  const detail = page.getByRole('region', { name: 'Extraction detail', exact: true })
  await expect(detail).toBeVisible()
  const old = await page.evaluate((id) => window.phosphor.invoke('brain:extraction', id), earlier)
  expect(old.prompts.every((p) => !p.startsWith('Prompt not available'))).toBe(true)
  await detail.getByRole('button', { name: 'Read again', exact: true }).click()
  await confirm.getByRole('button', { name: 'Read again', exact: true }).click()
  await expect(inbox(page, lane)).toContainText('reading again')
  for (const memory of old.memories)
    expect(
      await page.evaluate((id) => window.phosphor.invoke('brain:memory', id), memory.id),
    ).toHaveProperty('memory.id', memory.id)
  const next = await approveLane(page, lane)
  expect(next).not.toBe(earlier)
  await expect(row).toContainText('2 memories')
  const fresh = await page.evaluate((id) => window.phosphor.invoke('brain:extraction', id), next)
  expect(fresh.memories).toHaveLength(2)
  for (const memory of old.memories) {
    expect(fresh.memories.map((m) => m.id)).not.toContain(memory.id)
    expect(
      await page.evaluate(
        (id) => window.phosphor.invoke('brain:memory', id).catch(String),
        memory.id,
      ),
    ).toContain('Brain memory not found')
  }
  expect(
    (await page.evaluate(() => window.phosphor.invoke('brain:history', 20))).items
      .filter((i) => i.job.sessionId === old.sessionId)
      .map((i) => i.job.id),
  ).toEqual([next])
}
test('Brain reads a queued lane with the reader selected in Settings', async () => {
  const seed = await seedBrainLanes()
  const argvLog = join(seed.workspace, 'brain-argv.jsonl')
  const originalWrapper = await readFile(seed.wrapper, 'utf8')
  await writeFile(
    seed.wrapper,
    `if (process.argv.some(arg => arg.endsWith('brain-fork-guard.mjs'))) require('node:fs').appendFileSync(${JSON.stringify(argvLog)}, JSON.stringify(process.argv.slice(2)) + '\\n');\n${originalWrapper}`,
  )
  const h = await launch({
    workspace: seed.workspace,
    agentDir: seed.agent,
    userDataDir: seed.profile,
    env: { PHOSPHOR_BRAIN_TEST_EMBEDDINGS: '1', PHOSPHOR_PI_STUB: seed.wrapper },
  })
  const { page } = h
  try {
    await enableBrain(page, seed.harbor)
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
    await page.getByRole('tab', { name: /^Lanes/ }).click()
    await awaitRead(page, seed.harbor)
    await expect(inbox(page, seed.harbor)).toContainText('2 memories')
    await expect(inbox(page, seed.harbor)).toContainText('Claude Opus 5')
    await inbox(page, seed.harbor).click()
    await page.getByRole('button', { name: 'See how it was read', exact: true }).click()
    await expect(page.getByRole('region', { name: 'Extraction detail' })).toContainText(
      'Claude Opus 5 · medium thinking',
    )
    const launches = (await readFile(argvLog, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line) as string[])
    const extract = launches.find((args) =>
      args.some((arg) => /extract-\d+\/system\.md$/.test(arg)),
    )
    expect(extract, 'Brain extract launch').toBeDefined()
    expect(extract![extract!.indexOf('--model') + 1]).toBe('pi-claude-cli/claude-opus-5')
    for (const args of launches) {
      expect(args[args.indexOf('--model') + 1]).toBe('pi-claude-cli/claude-opus-5')
      expect(args[args.indexOf('--thinking') + 1]).toBe('medium')
    }
    expect(await readFile(seed.harbor.source, 'utf8')).toBe(seed.harbor.original)
  } finally {
    await shutdown(h)
  }
})

test('Brain review wraps a 300-character identity description without sideways scrolling', async () => {
  const seed = await seedBrainLanes()
  const h = await launch({
    workspace: seed.workspace,
    agentDir: seed.agent,
    userDataDir: seed.profile,
    env: { PHOSPHOR_BRAIN_TEST_EMBEDDINGS: '1', PHOSPHOR_PI_STUB: seed.wrapper },
  })
  try {
    const { page } = h
    await enableBrain(page, seed.harbor)
    await queueLane(page, seed.harbor)
    await awaitRead(page, null)
    const job = (await status(page)).jobs[0]!
    const proposal = await page.evaluate(
      (id) => window.phosphor.invoke('brain:proposal', id),
      job.id,
    )
    const identity = proposal.identities[0]!
    identity.decision = 'reuse'
    identity.entityId = 'harbor-candidate'
    identity.candidates = [
      {
        id: 'harbor-candidate',
        label: 'Harbor',
        kind: 'project',
        aliases: [],
        description: 'Harbor and Ledger share a billing workflow with Kestrel. '
          .repeat(6)
          .slice(0, 300),
      },
      {
        id: 'ledger-candidate',
        label: 'Ledger',
        kind: 'project',
        aliases: [],
        description: 'Another project.',
      },
    ]
    await h.app.evaluate(({ ipcMain }, value) => {
      ipcMain.removeHandler('brain:proposal')
      ipcMain.handle('brain:proposal', () => value)
    }, proposal)
    const lanes = page.getByRole('tab', { name: /^Lanes/ })
    if (await lanes.count()) await lanes.click()
    await page
      .getByRole('button', { name: 'Review', exact: true })
      .or(page.locator('.page-shell').getByRole('button', { name: seed.harbor.title, exact: true }))
      .click()
    const review = page.getByRole('region', { name: 'Review memories', exact: true })
    await expect(review).toBeVisible()
    expect(
      await review.evaluate((element) => {
        let pane: HTMLElement | SVGElement | null = element
        while (pane && !['auto', 'scroll'].includes(getComputedStyle(pane).overflowY))
          pane = pane.parentElement
        if (!pane) throw new Error('Missing review scroll container')
        return { scroll: pane.scrollWidth, client: pane.clientWidth }
      }),
    ).toEqual(expect.objectContaining({ scroll: expect.any(Number) }))
    const fits = await review.evaluate((element) => {
      let pane: HTMLElement | SVGElement | null = element
      while (pane && !['auto', 'scroll'].includes(getComputedStyle(pane).overflowY))
        pane = pane.parentElement
      return !!pane && pane.scrollWidth <= pane.clientWidth
    })
    expect(fits, 'review scrollWidth <= clientWidth').toBe(true)
    await expectReviewOutcomeAligned(page)
    await expectBrainPanesToFit(page)
  } finally {
    await shutdown(h)
  }
})

async function graphSelection(page: Page): Promise<void> {
  await page.getByRole('tab', { name: 'Knowledge', exact: true }).click()
  const nodes = page.getByRole('list', { name: 'Graph entities' })
  await expect(nodes.getByRole('button')).toHaveCount(3)
  const count = await nodes.getByRole('button').count()
  expect(count).toBe(3)
  const rina = nodes.getByRole('button', { name: 'Focus Rina Okafor', exact: true })
  // The accessible list is visually hidden; keyboard activation exercises the same node action.
  await rina.focus()
  await rina.press('Enter')
  await expect(page.getByRole('button', { name: 'Whole graph', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  )
  await expect(nodes.getByRole('button')).toHaveCount(count)
  await expectGraphFocusClear(page)
  await expect(nodes.getByRole('button', { name: 'Focus Harbor', exact: true })).toHaveAttribute(
    'data-highlighted',
    'false',
  )
  await page.keyboard.press('Escape')
  await expect(page.getByRole('button', { name: 'Clear selection', exact: true })).toHaveCount(0)
  await expect(nodes.getByRole('button', { name: 'Focus Harbor', exact: true })).toHaveAttribute(
    'data-highlighted',
    'true',
  )
  await rina.focus()
  await rina.press('Enter')
  await page.getByRole('button', { name: 'Neighbours only', exact: true }).click()
  await expect(nodes.getByRole('button')).toHaveCount(2)
  await page.getByRole('button', { name: '2 steps', exact: true }).click()
  await expect(nodes.getByRole('button')).toHaveCount(3)
  await page.getByRole('button', { name: 'Whole graph', exact: true }).click()
  await expect(nodes.getByRole('button')).toHaveCount(count)
  await page.getByRole('button', { name: 'Clear selection', exact: true }).click()
  await expect(page.getByRole('button', { name: 'Whole graph', exact: true })).toHaveCount(0)
  await expect(nodes.getByRole('button')).toHaveCount(count)
  await expectBrainPanesToFit(page)
}

async function expectBrainPanesToFit(page: Page): Promise<void> {
  const original = await page.evaluate(() => ({ width: innerWidth, height: innerHeight }))
  for (const width of [1280, 1000, 800]) {
    await page.setViewportSize({ width, height: original.height })
    await expect
      .poll(
        () =>
          page.locator('.page-shell').evaluate((shell) => {
            const panes = [
              shell,
              ...shell.querySelectorAll<HTMLElement>(
                '.brain-knowledge-column, [aria-label="Graph explorer"], [aria-label="Brain lanes"], .brain-lane-detail',
              ),
            ]
            return panes
              .filter(
                (pane) =>
                  pane.getBoundingClientRect().width > 0 && pane.scrollWidth > pane.clientWidth,
              )
              .map((pane) => pane.getAttribute('aria-label') ?? pane.className)
          }),
        { message: `Brain panes fit at ${width}px` },
      )
      .toEqual([])
  }
  await page.setViewportSize(original)
}

test('Brain caps long read text and anchors a short review action bar', async () => {
  const seed = await seedBrainLanes()
  const h = await launch({
    workspace: seed.workspace,
    agentDir: seed.agent,
    userDataDir: seed.profile,
    env: { PHOSPHOR_BRAIN_TEST_EMBEDDINGS: '1', PHOSPHOR_PI_STUB: seed.wrapper },
  })
  const { page } = h
  try {
    await enableBrain(page, seed.harbor)
    await queueLane(page, seed.harbor)
    await awaitRead(page, null)
    const job = (await status(page)).jobs[0]!
    const proposal = await page.evaluate(
      (id) => window.phosphor.invoke('brain:proposal', id),
      job.id,
    )
    const record = await page.evaluate(
      (id) => window.phosphor.invoke('brain:extraction', id),
      job.id,
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
    await page.getByRole('tab', { name: 'Knowledge', exact: true }).click()
    await h.app.evaluate(
      ({ ipcMain }, value) => {
        ipcMain.removeHandler('brain:proposal')
        ipcMain.handle('brain:proposal', () => ({
          ...value.proposal,
          memories: [],
          identities: [],
          groups: [],
          confirmations: [],
        }))
        ipcMain.removeHandler('brain:extraction')
        ipcMain.handle('brain:extraction', () => value.record)
      },
      { proposal, record },
    )
    await page.getByRole('tab', { name: /^Lanes/ }).click()
    await inbox(page, seed.harbor).click()
    await expectReviewBarAtBottom(page)
    await page.getByRole('button', { name: 'See how it was read', exact: true }).click()
    await expectBoundedReadText(page)
  } finally {
    await shutdown(h)
  }
})

test('Brain Tidy reviews shared names, opens its rolling notice, checks, swaps the survivor and undoes', async () => {
  // Two reads and a Tidy model batch each get their own budget on a loaded runner.
  test.setTimeout(240_000)
  const seed = await seedBrainTidyLanes()
  const h = await launch({
    workspace: seed.workspace,
    agentDir: seed.agent,
    userDataDir: seed.profile,
    env: { PHOSPHOR_BRAIN_TEST_EMBEDDINGS: '1', PHOSPHOR_PI_STUB: seed.wrapper },
  })
  const { page } = h
  try {
    await enableBrain(page, seed.harbor)
    await readTidyLane(page, seed.harbor)
    await readTidyLane(page, seed.ledger)
    const count = (await status(page)).tidy.open
    expect(count).toBeGreaterThan(0)
    await expect(page.getByRole('tab', { name: /^Tidy/ })).toContainText(String(count))
    await page.getByRole('tab', { name: /^Tidy/ }).click()
    const people = page.getByRole('region', { name: 'Same person or thing?', exact: true })
    await expect(people).toContainText('Rina Okafor')
    await openTidyNotice(page, count)
    await page.getByRole('button', { name: 'Tidy now', exact: true }).click()
    await expect(
      page.getByRole('status').filter({ hasText: /^Checking \d+ of \d+$/ }),
    ).toBeVisible()
    const detail = page.getByRole('article', { name: 'Tidy suggestion', exact: true })
    await expect(detail).toContainText('Same supported fixture assertion.', {
      timeout: READ_TIMEOUT,
    })
    await expect(detail).toContainText('Checked by')
    await mergeSwapAndUndo(page)
    for (const lane of [seed.harbor, seed.ledger])
      expect(await readFile(lane.source, 'utf8')).toBe(lane.original)
  } catch (error) {
    await attachBrainFailure(page)
    throw error
  } finally {
    await shutdown(h)
  }
})
