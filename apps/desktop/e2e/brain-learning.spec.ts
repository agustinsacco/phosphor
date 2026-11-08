import { test, expect } from '@playwright/test'
import { randomUUID } from 'node:crypto'
import { mkdir, readFile, readdir, realpath, writeFile } from 'node:fs/promises'
import { basename, join } from 'node:path'
import { sessionDirForCwd } from '@phosphor/session-runtime/pi/pi-paths'
import { launch, openWorkspace, privateAgentDir, shutdown } from './fixtures/local-app'
import { scratchDir } from './fixtures/scratch'

async function sourceFixture() {
  const workspace = await realpath(await scratchDir('phosphor-learning-e2e-'))
  const agentDir = privateAgentDir()
  const directory = sessionDirForCwd(workspace, join(agentDir, 'sessions'))
  await mkdir(directory, { recursive: true })
  const id = randomUUID(),
    timestamp = new Date().toISOString()
  const path = join(directory, `${timestamp.replace(/[:.]/g, '-')}_${id}.jsonl`)
  const entries = [
    { type: 'session', version: 3, id, timestamp, cwd: workspace },
    { type: 'model_change', id: 'model', parentId: null, provider: 'openai', modelId: 'synthetic' },
    { type: 'thinking_level_change', id: 'thinking', parentId: 'model', thinkingLevel: 'off' },
    {
      type: 'message',
      id: 'user',
      parentId: 'thinking',
      message: { role: 'user', content: 'Synthetic task' },
    },
    {
      type: 'message',
      id: 'answer',
      parentId: 'user',
      message: {
        role: 'assistant',
        provider: 'openai',
        model: 'synthetic',
        api: 'openai-responses',
        content: [{ type: 'text', text: 'Synthetic completed answer' }],
        stopReason: 'stop',
        timestamp: 1,
      },
    },
    { type: 'session_info', id: 'name', parentId: 'answer', name: 'Synthetic learning source' },
  ]
  const original = entries.map((entry) => JSON.stringify({ timestamp, ...entry })).join('\n') + '\n'
  await writeFile(path, original)
  return { workspace, agentDir, path, original }
}

test('selected folder learning needs no legacy model and refuses an unqualified runtime without changing its source', async () => {
  const source = await sourceFixture()
  const h = await launch({ workspace: source.workspace, agentDir: source.agentDir })
  try {
    await openWorkspace(h.page)
    await h.page.getByRole('button', { name: 'Brain', exact: true }).click()
    await h.page
      .getByRole('navigation', { name: 'Brain sections' })
      .getByRole('button', { name: 'Settings', exact: true })
      .click()
    await h.page.getByRole('checkbox', { name: 'Enable Brain', exact: true }).check()
    await h.page.getByRole('checkbox', { name: new RegExp(basename(h.workspace)) }).check()
    await expect(h.page.getByRole('button', { name: 'Save Brain settings' })).toBeDisabled()
    await h.page.getByRole('checkbox', { name: /I consent to capture/ }).check()
    await h.page.getByRole('button', { name: 'Save Brain settings' }).click()
    await expect
      .poll(
        async () =>
          (await h.page.evaluate(() => window.phosphor.invoke('brain:status'))).snapshot.prefs
            .enabled,
      )
      .toBe(true)
    const row = h.page.getByTestId('session-row').filter({ hasText: 'Synthetic learning source' })
    await expect(row).toBeVisible()
    await row.click({ button: 'right' })
    await h.page
      .getByTestId('context-menu')
      .getByRole('button', { name: /^Learn from this lane/ })
      .click()
    const dialog = h.page.getByRole('dialog', { name: 'Learn from this lane', exact: true })
    await expect(dialog.getByRole('alert')).toContainText('ordinary pi test stub')
    await expect(dialog.getByRole('button', { name: 'Retry preflight' })).toBeVisible()
    await dialog.getByRole('button', { name: 'Close', exact: true }).click()
    await expect(dialog).toHaveCount(0)
    const status = await h.page.evaluate(() => window.phosphor.invoke('brain:status'))
    expect(status.snapshot.prefs.processor).toBeNull()
    expect(status.snapshot.jobs).toEqual([])
    expect(status.snapshot.counts.evidence).toBe(0)
    expect(await h.page.evaluate(() => window.phosphor.invoke('pi:listLiveSessions'))).toEqual([])
    const userData = await h.app.evaluate(({ app }) => app.getPath('userData'))
    expect(await readdir(join(userData, 'brain', 'learning'))).toEqual([])
    expect(await readFile(source.path, 'utf8')).toBe(source.original)
  } finally {
    await shutdown(h)
  }
})
