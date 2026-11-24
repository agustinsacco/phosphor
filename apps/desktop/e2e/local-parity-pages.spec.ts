import { expect } from '@playwright/test'
import { test, folderName, serviceView } from './fixtures/local-parity'
import { LOCAL_MACHINE_LABEL } from './fixtures/local-machine'

test('routine discovery and artifact library read only from This Mac’s service across reconnect', async ({
  parity: { page, daemon },
}) => {
  const artifacts = () => page.evaluate(() => window.phosphor.invoke('artifacts:list', []))
  const discovery = await page.evaluate(() => window.phosphor.invoke('routines:list'))
  expect(discovery.routines).toEqual([])
  expect(discovery.machines).toMatchObject([{ id: `host:${daemon.machineId}`, available: true }])
  const routines = await page.evaluate(
    (id) => window.phosphor.invoke('routines:list', id),
    `host:${daemon.machineId}`,
  )
  expect(routines.routines.map((r) => r.name)).toEqual(['Service routine'])
  await expect
    .poll(async () => (await artifacts()).map((a) => a.title))
    .toEqual(['Service artifact'])
  await daemon.stop()
  const folders = () =>
    page.evaluate(() =>
      window.phosphor.invoke('ops:run', { kind: 'local' }, { op: 'folder.list', args: {} }),
    )
  await expect.poll(folders).toMatchObject({ status: 'denied', code: 'unavailable' })
  const down = await artifacts().catch(() => [])
  expect(down).toEqual([])
  await daemon.restart()
  await expect
    .poll(folders)
    .toMatchObject({ status: 'ok', data: { folders: [{ name: folderName }] } })
  await expect
    .poll(async () => (await artifacts()).map((a) => a.title))
    .toEqual(['Service artifact'])
})

for (const [tab, service, frozen] of [
  ['Skills', 'host-only', 'frozen-skill'],
  ['Routines', 'Service routine', 'Frozen Desktop routine'],
  ['Artifacts', 'Service artifact', 'Frozen Desktop artifact'],
] as const) {
  test(`${tab} shows the service collection, then unavailable, then the recovered collection`, async ({
    parity: { page, daemon },
  }) => {
    await page.getByRole('button', { name: tab, exact: true }).first().click()
    const screen = page.getByTestId('global-page')
    await expect(screen).toContainText(service)
    await expect(screen).not.toContainText(frozen)
    await daemon.stop()
    await expect(screen).toContainText(/not connected|reconnect|unavailable/i)
    await expect(screen).not.toContainText(service)
    await expect(screen).not.toContainText(frozen)
    await daemon.restart()
    await expect(screen).toContainText(service)
    await expect(screen).not.toContainText(frozen)
  })
}

test('machine Settings shows the registered service folder and recovers in place', async ({
  parity: { page, daemon },
}) => {
  await page
    .getByTestId('account-footer')
    .getByRole('button', { name: 'Settings', exact: true })
    .click()
  const dialog = page.getByRole('dialog', { name: 'Settings', exact: true })
  await dialog
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'Folders', exact: true })
    .click()
  await expect(dialog.getByTestId('settings-machine-scope')).toContainText(
    `Configuring ${LOCAL_MACHINE_LABEL}`,
  )
  await expect(dialog).toContainText(`${daemon.roots.home}/${folderName}`)
  await expect(dialog).not.toContainText('frozen-workspace')
  await daemon.stop()
  await expect.poll(async () => (await serviceView(page, daemon))?.state).not.toBe('ready')
  await expect(dialog).toContainText(/Connecting|Not connected/i)
  await expect(dialog).not.toContainText(folderName)
  await expect(dialog).not.toContainText('frozen-workspace')
  await daemon.restart()
  await expect(dialog).toContainText(`${daemon.roots.home}/${folderName}`)
})
