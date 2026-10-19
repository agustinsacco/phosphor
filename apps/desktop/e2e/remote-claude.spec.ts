import { test, expect } from '@playwright/test'
import { REMOTE_TEST_TIMEOUT, remoteHostFixture } from './fixtures/remote-host'
import { captures } from './fixtures/remote-ui'

test('real Host Claude detail explains the missing provider and refreshes after installation', async () => {
  test.setTimeout(REMOTE_TEST_TIMEOUT)
  const h = await remoteHostFixture({ claude: true })
  const fix = 'pi install npm:@saccolabs/pi-claude-cli'
  try {
    await h.signIn()
    await h.page.getByRole('button', { name: 'Machines', exact: true }).click()
    await h.page.getByTestId('enrolled-machine-row').click()
    const detail = h.page.getByTestId('machine-detail')
    const claude = detail
      .getByRole('heading', { name: 'Claude Code', exact: true })
      .locator('../..')
    await expect(claude).toContainText('Claude Code provider missing')
    await expect(claude.locator('code')).toHaveText(fix)
    await captures(h, test.info(), 'claude-detail-machine')

    const machine = h.state.machines[0]
    if (!machine) throw new Error('Missing fixture machine')
    h.state.approvedMachine = machine
    await h.page.getByRole('button', { name: 'Back to machines', exact: true }).click()
    await h.page.getByRole('button', { name: 'Add a machine', exact: true }).first().click()
    const dialog = h.page.getByRole('dialog', { name: 'Add a machine', exact: true })
    await dialog.getByRole('button', { name: 'Continue to Install', exact: true }).click()
    await dialog.getByRole('button', { name: 'I have a code', exact: true }).click()
    await dialog.getByRole('textbox', { name: 'Code', exact: true }).fill('BCDFGHJK')
    await dialog.getByRole('button', { name: 'Look up code', exact: true }).click()
    await dialog.getByRole('button', { name: 'Approve machine', exact: true }).click()
    // Online advances on its own once the real Host connection is ready.
    const providers = dialog.getByRole('region', { name: 'Providers', exact: true })
    await expect(providers).toBeVisible()
    await expect(providers).toContainText('Claude Code provider missing')
    await expect(providers.locator('code').filter({ hasText: fix })).toHaveText(fix)
    await expect(providers.getByText('Claude Pro/Max: Ready', { exact: true })).toBeVisible()
    await expect(providers).toContainText('Claude Code: Claude Code provider missing')
    await captures(h, test.info(), 'claude-detail-providers')

    await providers.getByRole('button', { name: 'Open machine Readiness', exact: true }).click()
    await expect(dialog).toBeHidden()
    await expect(claude).toContainText('Claude Code provider missing')
    await h.installClaudeProvider()
    await detail.getByRole('button', { name: 'Machine actions', exact: true }).click()
    await h.page.getByRole('button', { name: 'Check again', exact: true }).click()
    await expect(claude).toContainText('Signed in and ready')
    await expect(claude).not.toContainText('Claude Code provider missing')
    await expect(claude.locator('code')).toHaveCount(0)
    await captures(h, test.info(), 'claude-detail-ready')
  } finally {
    await h.close()
  }
})
