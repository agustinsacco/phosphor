import { expect } from '@playwright/test'
import { test, sidebar, folderName, savedTitle, serviceView } from './fixtures/local-parity'

test('local ops:run reads the registered folder from the fixture service', async ({
  parity: { page, daemon },
}) => {
  const result = await page.evaluate(() =>
    window.phosphor.invoke('ops:run', { kind: 'local' }, { op: 'folder.list', args: {} }),
  )
  expect(result).toMatchObject({
    status: 'ok',
    data: {
      folders: [{ name: folderName, path: `${daemon.roots.home}/${folderName}` }],
      next: null,
    },
  })
})

test('sidebar lists only the service lane under This Mac, without a control handoff', async ({
  parity: { page, daemon },
}) => {
  const machine = sidebar(page)
  await expect(machine).toHaveCount(1)
  const row = machine.getByTestId('remote-session-row').filter({ hasText: savedTitle })
  await expect(row).toBeVisible()
  await expect(page.getByTestId('session-row')).toHaveCount(0)
  await row.click({ button: 'right' })
  await expect(
    page.getByTestId('context-menu').getByRole('button', { name: 'Open', exact: true }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: /^(Take|Release) control/ })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await row.click()
  await expect(page.getByRole('banner')).toContainText(savedTitle)
  await expect(page.getByRole('button', { name: /^(Take|Release) control/ })).toHaveCount(0)
  await daemon.stop()
  await expect.poll(async () => (await serviceView(page, daemon))?.state).not.toBe('ready')
  await expect(row).toHaveCount(0)
  await expect(page.getByText('Frozen Desktop lane', { exact: true })).toHaveCount(0)
  await daemon.restart()
  await expect(row).toBeVisible()
})
