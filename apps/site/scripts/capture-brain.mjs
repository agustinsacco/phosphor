/* global window */
import { expect } from '@playwright/test'
import { source, root, shot, settings } from './capture-harness.mjs'

export async function captureBrain(page) {
  await page.evaluate(async (root) => {
    const { installBrainDemo } = await import(
      `/@fs${root}apps/site/scripts/fixtures/brain-backend.mjs`
    )
    installBrainDemo()
  }, root)
  await settings(page, 'brain')
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
  await expect(dialog).toContainText('Keeps your settings and embedding model.')
  await shot(page, 'brain-setup', dialog)
  await dialog.getByRole('switch', { name: 'Brain', exact: true }).click()
  await expect(dialog.getByRole('status')).toContainText('Search runs on this computer.', {
    timeout: 12000,
  })
  await shot(page, 'brain-ready', dialog)
  await dialog.getByRole('button', { name: 'Open Brain', exact: true }).click()
  const shell = page
    .locator('.page-shell')
    .filter({ has: page.getByRole('region', { name: 'Map', exact: true }) })
  const handover = /Tom Lee took over Harbor ledger from Rina Okafor/
  await expect(shell.getByRole('button', { name: /^Rina Okafor,.*centre/ })).toBeVisible()
  await shell
    .locator('[data-edge]')
    .filter({ has: page.locator('title', { hasText: handover }) })
    .focus()
  await expect(shell.locator('[data-edge-words]').first()).toBeVisible()
  await shot(page, 'brain-graph', shell)
  await shell.getByRole('region', { name: 'Now' }).getByRole('button', { name: handover }).click()
  await expect(shell.getByRole('region', { name: 'Before' })).toContainText('until')
  await expect(shell.getByRole('region', { name: 'Together' })).toContainText('Northwind')
  await shell.locator('[data-ended="true"]').focus()
  await shot(page, 'brain-memory', shell)
  await captureChanges(page)
  await shell.getByRole('button', { name: 'Back', exact: true }).click()
  await captureQueue(page, shell)
}

async function captureChanges(page) {
  const changes = page.getByRole('region', { name: 'What changed' })
  await expect(changes.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled()
  await expect(changes.getByRole('button', { name: 'Undo run' })).toBeEnabled()
  await shot(page, 'brain-changes', changes)
  await changes.getByRole('button', { name: 'How Harbor handover was read' }).click()
  const record = page.getByRole('dialog', { name: 'How Harbor handover was read' })
  await expect(record.getByRole('region', { name: 'Read result' })).toContainText('2 kept')
  await shot(page, 'brain-extraction', record)
  await record.getByRole('button', { name: 'Close', exact: true }).click()
}

async function captureQueue(page, shell) {
  await page.evaluate(async (source) => {
    for (const title of ['Harbor rollout', 'Ledger checkpoint']) {
      await window.phosphor.invoke('brain:queue', {
        sessionPath: `/demo/Harbor/${title}.jsonl`,
        title,
        scope: '/demo/Harbor',
        branch: null,
        model: null,
      })
    }
    const { useBrain } = await import(`${source}features/brain/useBrain.ts`)
    await useBrain.getState().refresh()
  }, source)
  await expect(page.getByRole('status', { name: 'Brain status' })).toContainText('1 queued')
  await shot(page, 'brain-queue', shell)
  await page.evaluate(async (source) => {
    const status = await window.phosphor.invoke('brain:status')
    for (const job of status.jobs) await window.phosphor.invoke('brain:cancel', job.id)
    const { useBrain } = await import(`${source}features/brain/useBrain.ts`)
    await useBrain.getState().refresh()
  }, source)
}
