import { test, expect } from '@playwright/test'
import { mkdir, readFile, realpath, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launch, shutdown, privateAgentDir } from './fixtures/local-app'
import { scratchDir } from './fixtures/scratch'

const id = '01a0272a-7be5-76ed-b420-36b363924633'
const fact = 'Rina Okafor owns the Harbor ledger export.'

const sessionDir = (agent: string, cwd: string) =>
  join(agent, 'sessions', `--${cwd.replace(/^[/\\]/, '').replace(/[/\\:]/g, '-')}--`)

/** A stopped lane on disk: the knowledge fork reads it, Brain never writes to it. */
async function seedLane() {
  const workspace = await realpath(await scratchDir('phosphor-e2e-brain-'))
  const profile = join(workspace, 'profile')
  const agent = privateAgentDir()
  const source = join(sessionDir(agent, workspace), `2026-11-06T12-00-00-000Z_${id}.jsonl`)
  await mkdir(profile)
  await mkdir(sessionDir(agent, workspace), { recursive: true })
  const at = (second: number) => `2026-11-06T12:00:0${second}Z`
  const original =
    [
      { type: 'session', version: 3, id, cwd: workspace, timestamp: at(0) },
      {
        type: 'session_info',
        id: 'name0001',
        parentId: null,
        name: 'Harbor ledger',
        timestamp: at(1),
      },
      {
        type: 'message',
        id: 'ask00001',
        parentId: 'name0001',
        timestamp: at(2),
        message: { role: 'user', content: `Note for later: ${fact} Exports run nightly.` },
      },
      {
        type: 'message',
        id: 'ans00001',
        parentId: 'ask00001',
        timestamp: at(3),
        message: {
          role: 'assistant',
          content: [{ type: 'text', text: 'Noted.' }],
          provider: 'stub',
          model: 'stub-model',
        },
      },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n') + '\n'
  await writeFile(source, original)
  await writeFile(
    join(profile, 'config.json'),
    JSON.stringify({
      lastWorkspacePath: workspace,
      recentWorkspaces: [{ path: workspace, name: 'Harbor' }],
    }),
  )
  return { workspace, profile, agent, source, original }
}

test('Brain learns only from a queued lane, after approval, and keeps the lane untouched', async () => {
  const { workspace, profile, agent, source, original } = await seedLane()
  const h = await launch({
    workspace,
    agentDir: agent,
    userDataDir: profile,
    env: { PHOSPHOR_BRAIN_TEST_EMBEDDINGS: '1' },
  })
  const { page } = h
  try {
    const row = page.getByTestId('session-row').filter({ hasText: 'Harbor ledger' }).first()
    await expect(row).toBeVisible({ timeout: 30_000 })
    const nav = page.getByRole('navigation', { name: 'Main navigation' })
    await expect(nav.getByRole('button', { name: 'Brain' })).toHaveCount(0)
    await row.click({ button: 'right' })
    await expect(page.getByText('Queue for knowledge extraction')).toHaveCount(0)
    await page.keyboard.press('Escape')

    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'Brain', exact: true }).click()
    await page.getByRole('switch', { name: 'Brain', exact: true }).click()
    await expect(page.getByRole('switch', { name: 'Review before saving' })).toBeChecked()
    await expect(page.getByText('EmbeddingGemma is ready.', { exact: false })).toBeVisible()
    await page.keyboard.press('Escape')
    await expect(nav.getByRole('button', { name: 'Brain' })).toBeVisible()

    await row.click({ button: 'right' })
    await page.getByText('Queue for knowledge extraction', { exact: true }).click()
    await nav.getByRole('button', { name: 'Brain' }).click()
    await expect(page.getByText('1 memory to review')).toBeVisible({ timeout: 30_000 })
    await page.getByRole('button', { name: 'Review', exact: true }).click()
    await expect(page.getByText('The lane named who owns what.')).toBeVisible()
    await expect(page.getByText('Nothing is searchable until you approve it.')).toBeVisible()
    await page.getByRole('button', { name: 'Approve 1', exact: true }).click()

    await expect(page.getByText(fact).first()).toBeVisible()
    await expect(page.locator('[data-graph] svg')).toBeVisible()
    const knowledge = await page.evaluate(() => window.phosphor.invoke('brain:knowledge'))
    expect(knowledge.memories.map((memory) => memory.summary)).toEqual([fact])
    expect(knowledge.entities.map((entity) => entity.label).sort()).toEqual([
      'Harbor ledger export',
      'Rina Okafor',
    ])

    await row.click({ button: 'right' })
    await page.getByText('Queue for knowledge extraction', { exact: true }).click()
    await expect(
      page.getByText('Nothing new in this lane since its last extraction.'),
    ).toBeVisible()

    await page.getByText(fact).first().click()
    await page.getByRole('button', { name: 'Forget', exact: true }).click()
    await expect
      .poll(async () => (await page.evaluate(() => window.phosphor.invoke('brain:status'))).counts)
      .toEqual({ memories: 0, entities: 0 })
    expect(await readFile(source, 'utf8')).toBe(original)
  } finally {
    await shutdown(h)
  }
})
