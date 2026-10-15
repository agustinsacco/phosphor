import { expect, test } from '@playwright/test'
import { accountControlFixture } from './fixtures/account-control'
import { REMOTE_TEST_TIMEOUT } from './fixtures/remote-host'
import { captures } from './fixtures/remote-ui'

test('machine awareness preview follows sign-in and the directive toggle', async ({
  browserName,
}, info) => {
  void browserName
  test.setTimeout(REMOTE_TEST_TIMEOUT)
  const h = await accountControlFixture()
  const { page } = h
  const open = async () => {
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    await page.getByRole('button', { name: 'Agent', exact: true }).click()
    await page.getByText(/What gets sent/).click()
  }
  try {
    await open()
    const preview = page.getByRole('dialog', { name: 'Settings', exact: true }).locator('pre')
    await expect(preview).not.toContainText('<phosphor_machine>')
    await page.keyboard.press('Escape')
    await h.signIn()
    await open()
    await expect(preview).toContainText("You are running on the user's own computer")
    const toggle = page.getByRole('switch', { name: 'Machine awareness', exact: true })
    await toggle.click()
    await expect(preview).not.toContainText('<phosphor_machine>')
    await expect
      .poll(
        async () =>
          (await page.evaluate(() => window.phosphor.invoke('app:getPrefs'))).agentDirectives
            .machineAwareness,
      )
      .toBe(false)
    await toggle.click()
    await expect(preview).toContainText('<phosphor_machine>')
    await toggle.scrollIntoViewIfNeeded()
    await captures(h, info, 'machine-directives')
    await preview.scrollIntoViewIfNeeded()
    await captures(h, info, 'machine-directives-preview')
  } finally {
    await h.close()
  }
})
