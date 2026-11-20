import { test, expect, type Page } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { launch, shutdown } from './fixtures/local-app'
import { seedBrainLanes } from './fixtures/brain-lanes'
import {
  awaitRead,
  brainNav,
  brainTab,
  defragButton,
  defragRead,
  enableBrain,
  queueLane,
  runStrip,
  status,
  waitingRow,
} from './fixtures/brain-flow'

const REASON = 'The lasting memories have evidence in this read.'

test('Brain Agent decides a waiting read, records its reason and undoes the run', async () => {
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
    await expect(defragButton(page)).toBeDisabled()
    await queueLane(page, seed.harbor)
    await awaitRead(page, seed.harbor)
    await brainTab(page, 'Lanes').click()
    await expect(waitingRow(page, seed.harbor)).toBeVisible()
    await expect(page.locator('.page-shell-header')).toContainText('1 waiting')
    await expect(brainNav(page)).toHaveAccessibleName('Brain 1 waiting')
    await defragButton(page).hover()
    await expect(page.getByRole('tooltip')).toContainText('1 waiting: 1 read')
    const id = await defragRead(page, seed.harbor)
    expect(
      await page.evaluate(
        async () => (await window.phosphor.invoke('app:getPrefs')).lastWorkspacePath,
      ),
    ).toBe(seed.workspace)
    const recent = page.getByRole('region', { name: 'Recent changes', exact: true })
    await expect(recent).toContainText('Brain Agent')
    await recent.getByRole('button', { name: /^Approved / }).click()
    await expect(page.getByRole('article', { name: 'Change detail' })).toContainText(REASON)
    expect(
      (await page.evaluate(() => window.phosphor.invoke('brain:tidyChanges', 50))).items[0],
    ).toMatchObject({ kind: 'approve', who: 'agent', jobId: id, reason: REASON })
    await runStrip(page).getByRole('button', { name: 'Undo run', exact: true }).click()
    await expect(waitingRow(page, seed.harbor)).toBeVisible()
    expect((await status(page)).counts.memories).toBe(0)
    await expect(page.locator('.page-shell-header')).toContainText('1 waiting')
    await expect(recent).toContainText('Undone')
  } finally {
    await shutdown(h)
  }
})

test('Brain lane attaches to its running turn once, Stop ends Defrag, and other lanes cannot curate', async () => {
  const seed = await seedBrainLanes()
  await writeFile(seed.hold, 'BRAIN_STUB_HOLD\n')
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
    await awaitRead(page, seed.harbor)
    await defragButton(page).click()
    await expect(runStrip(page)).toContainText('Brain Agent is defragging')
    await expect(runStrip(page).getByRole('button', { name: 'Brain lane' })).toBeEnabled()
    await runStrip(page).getByRole('button', { name: 'Brain lane' }).click()
    const group = page.getByRole('region', { name: 'Brain', exact: true })
    await expect(group.getByTestId('session-row')).toContainText('🧠')
    await expect(group.getByTestId('session-row')).toContainText('Brain Agent')
    await expect(page.getByRole('main').getByText(/^Defrag\. 1 waiting:/)).toBeVisible()
    expect((await status(page)).agent.run?.state).toBe('running')
    await group.getByTestId('session-row').click({ button: 'right' })
    await expect(page.getByText('Queue for knowledge extraction', { exact: true })).toHaveCount(0)
    await page.keyboard.press('Escape')
    await expect
      .poll(() => launches(seed.audit, (cwd) => cwd.endsWith('/brain/Brain')))
      .toHaveLength(1)
    await brainNav(page).click()
    await runStrip(page).getByRole('button', { name: 'Stop', exact: true }).click()
    await expect.poll(async () => (await status(page)).agent.run?.state).toBe('stopped')
    await expect(runStrip(page)).toContainText('stopped')
    await brainTab(page, 'Lanes').click()
    await expect(waitingRow(page, seed.harbor)).toBeVisible()
    await page.getByRole('button', { name: 'Close page', exact: true }).click()
    await page.getByTestId('session-row').filter({ hasText: seed.ledger.title }).first().click()
    await send(page, 'BRAIN_STUB_CURATOR_PROBE')
    await expect(page.getByText('Curator methods refused.', { exact: true })).toBeVisible()
    await expect
      .poll(() => launches(seed.audit, (cwd) => cwd.endsWith('/brain/Brain')))
      .toHaveLength(1)
    const ordinary = await launches(seed.audit, (cwd) => cwd === seed.workspace)
    expect(ordinary).toHaveLength(1)
    expect(ordinary[0]).toMatchObject({ hasToken: true, curator: false })
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
async function send(page: Page, message: string) {
  await page.getByRole('textbox', { name: 'Chat message', exact: true }).fill(message)
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
}
