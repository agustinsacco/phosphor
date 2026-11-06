import { test, expect } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { launch, shutdown, openWorkspace } from './fixtures/local-app'
import { scratchDir } from './fixtures/scratch'

test('rewind restores current Swarm authorization before allowing the next prompt', async () => {
  const workspace = await scratchDir('phosphor-e2e-transition-')
  const log = join(workspace, 'commands.jsonl')
  const h = await launch({ workspace, env: { PHOSPHOR_E2E_COMMAND_LOG: log } })
  const { page } = h
  try {
    await openWorkspace(page)
    await page.getByPlaceholder('Describe a task or ask a question').fill('hello')
    await page.getByRole('button', { name: /Start lane/i }).click()
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled({
      timeout: 30_000,
    })
    const swarm = page.getByRole('switch', { name: 'Swarm', exact: true })
    await swarm.click()
    await expect(swarm).toBeChecked()
    const mod = process.platform === 'darwin' ? 'Meta' : 'Control'
    await page.keyboard.press(`${mod}+k`)
    await page.getByPlaceholder('Type a command…').fill('Rewind')
    await page.getByText('Rewind to an earlier message…').click()
    await page.getByRole('button', { name: /stub session/ }).click()
    const composer = page.getByPlaceholder(/Describe a task…/i)
    await expect(composer).toBeEnabled()
    await expect(composer).toHaveText('stub session')
    await expect(swarm).toBeChecked()
    const commands = (await readFile(log, 'utf8'))
      .trim()
      .split('\n')
      .map((line) => JSON.parse(line))
    expect(commands.filter((c) => c.type === 'fork')).toHaveLength(1)
    expect(commands.filter((c) => c.message === '/phosphor-swarm on')).toHaveLength(2)
    await composer.press('Enter')
    await expect(page.getByRole('button', { name: 'Continue', exact: true })).toBeEnabled({
      timeout: 30_000,
    })
  } finally {
    await shutdown(h)
  }
})
