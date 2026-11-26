import { expect, test } from '@playwright/test'
import { remoteHostFixture, REMOTE_TEST_TIMEOUT } from './fixtures/remote-host'
import { openMachineSettings } from './fixtures/remote-ui'

test('Advanced updates a Host inline and explains a source-install refusal', async () => {
  test.setTimeout(Math.max(REMOTE_TEST_TIMEOUT, 90_000))
  const h = await remoteHostFixture({ native: true })
  try {
    await h.signIn()
    const settings = await openMachineSettings(h, 'Advanced')
    const software = settings.getByRole('region', { name: 'Software', exact: true })
    await expect(software).toContainText('Phosphor Host')
    await software.getByRole('button', { name: 'Update…', exact: true }).click()
    const confirm = h.page.getByRole('dialog', { name: 'Update Phosphor Host on bee1?' })
    await expect(confirm).toContainText('waits for working turns')
    await confirm.getByRole('button', { name: 'Update', exact: true }).click()
    await expect(software).toContainText('not installed from a release')
    await expect(h.page.getByRole('dialog', { name: 'Host update', exact: true })).toHaveCount(0)
    await expect(software.getByText('Show details', { exact: true })).toBeVisible()
  } finally {
    await h.close()
  }
})
