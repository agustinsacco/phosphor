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

test('boot completes without the workspace preferences error', async ({ parity: { page } }) => {
  await expect(page.getByTestId('app-shell')).toBeVisible()
  await expect(page.getByText('Couldn’t load your workspace preferences.')).toHaveCount(0)
})

test('start in a service folder, pin, mark, stop and archive the daemon lane', async ({
  parity: { page, daemon },
}) => {
  const group = sidebar(page)
  await group.getByRole('button', { name: `New lane in ${folderName}` }).click()
  const prompt = 'PHX-parity'
  await page.getByPlaceholder('Describe a task or ask a question').fill(prompt)
  await page.getByRole('button', { name: 'Start lane', exact: true }).click()
  // Host fake-pi echoes PHX tokens; the in-app stub never gives this reply.
  await expect(page.locator('main').getByText(prompt, { exact: true })).toHaveCount(2)
  const created = (await serviceView(page, daemon))?.lanes.find((l) => l.title !== savedTitle)
  expect(created?.cwd).toBe(`${daemon.roots.home}/${folderName}`)
  const state = async () =>
    (await serviceView(page, daemon))?.lanes.find((l) => l.laneId === created!.laneId)
  const row = group.getByTestId('remote-session-row').filter({ hasNotText: savedTitle })
  const menuClick = async (name: string) => {
    await row.click({ button: 'right' })
    await page.getByTestId('context-menu').getByRole('button', { name, exact: true }).click()
  }
  await menuClick('Pin')
  await expect.poll(async () => (await state())?.pinned).toBe(true)
  await menuClick('Lane marker…')
  await page.getByRole('dialog', { name: 'Lane marker' }).getByLabel('Search icons').fill('🚀')
  await page
    .getByRole('dialog', { name: 'Lane marker' })
    .getByRole('button', { name: 'rocket', exact: true })
    .click()
  await expect.poll(async () => (await state())?.marker).toBe('🚀')
  await menuClick('Stop')
  await expect.poll(async () => (await state())?.activity).toBe('stopped')
  await menuClick('Archive')
  await page.getByRole('button', { name: 'Archive lane', exact: true }).click()
  await expect.poll(state).toBeUndefined()
  const archives = await page.evaluate(() =>
    window.phosphor.invoke('ops:run', { kind: 'local' }, { op: 'archive.list', args: {} }),
  )
  expect(archives.status).toBe('ok')
  expect(JSON.stringify(archives)).toContain(folderName)
})
