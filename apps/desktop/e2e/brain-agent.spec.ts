import { test, expect, type Page } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { launch, shutdown } from './fixtures/local-app'
import { seedBrainLanes } from './fixtures/brain-lanes'
import {
  AUTO_RUN_TIMEOUT,
  awaitSaved,
  brainNav,
  card,
  changes,
  defragButton,
  edge,
  enableBrain,
  queueLane,
  searchTo,
  status,
  statusBar,
  whatChanged,
} from './fixtures/brain-flow'

const WORKS_WITH = 'Rina Okafor works with Mara Voss'

test('Brain Agent settles an unlinked pair on its own after a saved read, and its run undoes', async () => {
  test.setTimeout(240_000)
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
    await awaitSaved(page, seed.harbor)
    await expect.poll(async () => (await status(page)).agent.waiting.unlinked).toBe(1)
    await expect(brainNav(page)).toHaveAccessibleName(/^Brain \d+ waiting$/)
    // Nobody presses Defrag: Brain Agent starts once reads have been quiet for a minute.
    await expect
      .poll(
        async () => {
          const run = (await status(page)).agent.run
          return run && { automatic: run.automatic, state: run.state }
        },
        { timeout: AUTO_RUN_TIMEOUT, intervals: [2_000] },
      )
      .toEqual({ automatic: true, state: 'done' })
    expect((await status(page)).agent.waiting.unlinked).toBe(0)
    const relate = (await changes(page)).items.find((item) => item.kind === 'relate')!
    expect(relate).toMatchObject({ who: 'agent', undoable: true })
    expect(relate.runId).toBe((await status(page)).agent.run!.id)
    expect(relate.reason).toBeTruthy()

    await searchTo(page, 'Rina Okafor')
    await expect(edge(page, WORKS_WITH)).toBeVisible()
    const now = card(page).getByRole('region', { name: 'Now', exact: true })
    const stated = now.getByRole('button', { name: WORKS_WITH, exact: true })
    await expect(stated).toContainText('by Brain Agent')
    const run = whatChanged(page).getByRole('listitem').filter({ hasText: 'Brain Agent run' })
    await expect(run).toContainText(relate.summary)
    await run.getByRole('button', { name: 'Undo run', exact: true }).click()
    await expect(edge(page, WORKS_WITH)).toHaveCount(0)
    await expect(now.getByRole('button', { name: WORKS_WITH, exact: true })).toHaveCount(0)
    expect((await changes(page)).items.find((i) => i.id === relate.id)?.undoneAt).not.toBeNull()
    // The read itself stays saved: only the run's changes were undone.
    expect((await status(page)).counts.memories).toBe(seed.harbor.facts.length)
  } finally {
    await shutdown(h)
  }
})

test('Brain lane attaches to its running turn once, Stop ends Defrag, and other lanes recall without Brain credentials', async () => {
  const seed = await seedBrainLanes()
  await writeFile(seed.hold, 'BRAIN_STUB_HOLD\n')
  const h = await launch({
    workspace: seed.workspace,
    agentDir: seed.agent,
    userDataDir: seed.profile,
    env: {
      PHOSPHOR_BRAIN_TEST_EMBEDDINGS: '1',
      PHOSPHOR_PI_STUB: seed.wrapper,
      PHOSPHOR_E2E_OPS: '1',
    },
  })
  const { page } = h
  try {
    await enableBrain(page, seed.harbor, { agentAuto: false })
    await queueLane(page, seed.harbor)
    await awaitSaved(page, seed.harbor)
    await defragButton(page).click()
    await expect(statusBar(page)).toContainText('Brain Agent is defragging')
    const lane = statusBar(page).getByRole('button', { name: 'Brain lane', exact: true })
    await expect(lane).toBeEnabled()
    await lane.click()
    const group = page.getByRole('region', { name: 'Brain', exact: true })
    await expect(group.getByTestId('session-row')).toContainText('🧠')
    await expect(group.getByTestId('session-row')).toContainText('Brain Agent')
    await expect(page.getByRole('main').getByText(/^Defrag\. \d+ waiting:/)).toBeVisible()
    expect((await status(page)).agent.run).toMatchObject({ state: 'running', automatic: false })
    await group.getByTestId('session-row').click({ button: 'right' })
    await expect(page.getByText('Queue for knowledge extraction', { exact: true })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect
      .poll(() => launches(seed.audit, (cwd) => cwd.endsWith('/brain/Brain')))
      .toHaveLength(1)
    await brainNav(page).click()
    await statusBar(page).getByRole('button', { name: 'Stop', exact: true }).click()
    await expect.poll(async () => (await status(page)).agent.run?.state).toBe('stopped')
    await expect(statusBar(page)).toContainText('stopped')
    expect((await status(page)).agent.waiting.unlinked).toBe(1)
    await page.getByRole('button', { name: 'Close page', exact: true }).click()
    await page.getByTestId('session-row').filter({ hasText: seed.ledger.title }).first().click()
    // Recall answers over the lane's op channel; curator verbs are not ops an agent may run.
    await send(page, opPrompt(['brain.search', 'Harbor']))
    await expect(
      page.getByRole('main').getByText(/No approved Brain memories matched\./),
    ).toBeVisible()
    await send(page, opPrompt(['brain.review']))
    await expect(page.getByText('brain.review is not available to agents.')).toBeVisible()
    await send(page, opPrompt(['brain.decideRead']))
    await expect(page.getByText(/^Unknown operation\./)).toBeVisible()
    await expect
      .poll(() => launches(seed.audit, (cwd) => cwd.endsWith('/brain/Brain')))
      .toHaveLength(1)
    const ordinary = await launches(seed.audit, (cwd) => cwd === seed.workspace)
    expect(ordinary).toHaveLength(1)
    expect(ordinary[0]).toMatchObject({ hasToken: false, curator: false })
    expect((await launches(seed.audit, (cwd) => cwd.endsWith('/brain/Brain')))[0]).toMatchObject({
      hasToken: true,
      curator: true,
    })
  } finally {
    await shutdown(h)
  }
})

async function launches(file: string, include: (cwd: string) => boolean) {
  const rows = (await readFile(file, 'utf8'))
    .trim()
    .split('\n')
    .map(
      (line) =>
        JSON.parse(line) as { cwd: string; pid: number; hasToken: boolean; curator: boolean },
    )
  return rows.filter((row) => include(row.cwd))
}
const opPrompt = (args: string[]) =>
  `Test op: ${JSON.stringify({ args, reason: 'Check what this lane may reach' })}`
async function send(page: Page, message: string) {
  await page.getByRole('textbox', { name: 'Chat message', exact: true }).fill(message)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
}
