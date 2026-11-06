import { test, expect } from '@playwright/test'
import { existsSync } from 'node:fs'
import { basename, join } from 'node:path'
import { launch, openWorkspace, shutdown } from './fixtures/local-app'
import { remoteHostFixture, REMOTE_TEST_TIMEOUT } from './fixtures/remote-host'
import { selectMachine } from './fixtures/remote-ui'

test('Brain boots the real database worker, stays opt-in, and persists reviewed settings', async () => {
  const h = await launch()
  try {
    await openWorkspace(h.page)
    await h.page.getByRole('button', { name: 'Brain', exact: true }).click()
    await expect(
      h.page.getByRole('heading', { name: 'Brain · This Mac', exact: true }),
    ).toBeVisible()
    await expect(h.page.getByText(/Brain is off by default/)).toBeVisible()
    const status = await h.page.evaluate(() => window.phosphor.invoke('brain:status'))
    expect(status.snapshot.prefs.enabled).toBe(false)
    expect(status.snapshot.counts.evidence).toBe(0)
    expect(status.snapshot.jobs).toEqual([])
    await h.page
      .getByRole('navigation', { name: 'Brain sections' })
      .getByRole('button', { name: 'Settings', exact: true })
      .click()
    await h.page.getByLabel('Accept embedding model terms').check()
    await expect(
      h.page.getByRole('button', { name: 'Download local embedding model' }),
    ).toBeDisabled()
    await h.page.getByRole('checkbox', { name: 'Enable Brain', exact: true }).check()
    await h.page.getByRole('textbox', { name: 'Exact provider', exact: true }).fill('openai')
    await h.page.getByRole('textbox', { name: 'Exact model ID', exact: true }).fill('synthetic')
    await h.page.getByRole('checkbox', { name: new RegExp(basename(h.workspace)) }).check()
    await expect(h.page.getByRole('button', { name: 'Save Brain settings' })).toBeDisabled()
    await h.page.getByRole('checkbox', { name: /I consent to capture/ }).check()
    await h.page.getByRole('button', { name: 'Save Brain settings' }).click()
    await expect(h.page.getByText(/Brain is off by default/)).toHaveCount(0)
    const enabled = await h.page.evaluate(() => window.phosphor.invoke('brain:status'))
    expect(enabled.snapshot.prefs.enabled).toBe(true)
    expect(enabled.snapshot.prefs.workspaces).toHaveLength(1)
    expect(enabled.snapshot.jobs).toEqual([])
    expect(['missing', 'unsupported']).toContain(enabled.embedding.phase)
    await h.page.reload()
    await h.page.getByRole('button', { name: 'Brain', exact: true }).click()
    await expect(h.page.getByRole('button', { name: 'Explore', exact: true })).toBeVisible()
    expect(
      (await h.page.evaluate(() => window.phosphor.invoke('brain:status'))).snapshot.prefs.enabled,
    ).toBe(true)
    await h.page
      .getByRole('navigation', { name: 'Brain sections' })
      .getByRole('button', { name: 'Settings', exact: true })
      .click()
    await h.page.getByRole('checkbox', { name: 'Enable Brain', exact: true }).uncheck()
    await h.page.getByRole('button', { name: 'Save Brain settings' }).click()
    await expect(h.page.getByText(/Brain is off by default/)).toBeVisible()
    await h.page.screenshot({ path: test.info().outputPath('brain-settings.png') })
  } finally {
    await shutdown(h)
  }
})

test('explicit Host Brain never opens local storage; All is labelled This Mac', async () => {
  test.setTimeout(REMOTE_TEST_TIMEOUT)
  const h = await remoteHostFixture()
  try {
    await h.signIn()
    await selectMachine(h, 'bee1')
    await h.page.getByRole('button', { name: 'Brain', exact: true }).click()
    await expect(h.page.getByText(/Brain is unavailable on this machine/)).toBeVisible()
    expect(existsSync(join(h.userData, 'brain'))).toBe(false)
    await selectMachine(h, 'All machines')
    await expect(
      h.page.getByRole('heading', { name: 'Brain · This Mac', exact: true }),
    ).toBeVisible()
    await expect(h.page.getByText(/Brain is off by default/)).toBeVisible()
    expect(existsSync(join(h.userData, 'brain'))).toBe(true)
  } finally {
    await h.close()
  }
})
