import { expect, type Page } from '@playwright/test'
import type { LocalDaemon } from './fixtures/local-daemon'
import { test, sidebar, folderName, laneRow, serviceView } from './fixtures/local-parity'

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
  const [saved] = (await serviceView(page, daemon))!.lanes
  const row = laneRow(page, daemon, saved!.laneId)
  await expect(row).toBeVisible()
  await expect(page.getByTestId('session-row')).toHaveCount(0)
  await row.click({ button: 'right' })
  await expect(
    page.getByTestId('context-menu').getByRole('button', { name: 'Open', exact: true }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: /^(Take|Release) control/ })).toHaveCount(0)
  await page.keyboard.press('Escape')
  await row.click()
  await expect(row).toHaveAttribute('aria-current', 'page')
  await expect.poll(async () => (await serviceView(page, daemon))!.lanes[0]?.activity).toBe('idle')
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

async function startLane(page: Page, daemon: LocalDaemon) {
  const [saved] = (await serviceView(page, daemon))!.lanes
  await sidebar(page)
    .getByRole('button', { name: `New lane in ${folderName}` })
    .click()
  await page.getByPlaceholder('Describe a task or ask a question').fill('PHX-parity')
  await page.getByRole('button', { name: 'Start lane', exact: true }).click()
  const created = async () =>
    (await serviceView(page, daemon))?.lanes.find((l) => l.laneId !== saved!.laneId)
  await expect.poll(created).toMatchObject({ cwd: `${daemon.roots.home}/${folderName}` })
  return (await created())!.laneId
}

test('start a lane in a service folder', async ({ parity: { page, daemon } }) => {
  const id = await startLane(page, daemon)
  await expect(laneRow(page, daemon, id)).toBeVisible()
})

test('new lane receives a reply from the daemon pi', async ({ parity: { page, daemon } }) => {
  await startLane(page, daemon)
  // Only Host fake-pi echoes a PHX token back to the user.
  await expect(page.locator('main').getByText('PHX-parity', { exact: true })).toHaveCount(2)
})

async function clickLaneMenu(page: Page, daemon: LocalDaemon, id: string, name: string) {
  await laneRow(page, daemon, id).click({ button: 'right' })
  await page.getByTestId('context-menu').getByRole('button', { name, exact: true }).click()
}

test('pin a service lane', async ({ parity: { page, daemon } }) => {
  const [saved] = (await serviceView(page, daemon))!.lanes
  const state = async () =>
    (await serviceView(page, daemon))?.lanes.find((l) => l.laneId === saved!.laneId)
  await clickLaneMenu(page, daemon, saved!.laneId, 'Pin')
  await expect.poll(async () => (await state())?.pinned).toBe(true)
})

test('change a service lane marker', async ({ parity: { page, daemon } }) => {
  const [saved] = (await serviceView(page, daemon))!.lanes
  const state = async () =>
    (await serviceView(page, daemon))?.lanes.find((l) => l.laneId === saved!.laneId)
  await clickLaneMenu(page, daemon, saved!.laneId, 'Lane marker…')
  await page.getByRole('dialog', { name: 'Lane marker' }).getByLabel('Search icons').fill('🚀')
  await page
    .getByRole('dialog', { name: 'Lane marker' })
    .getByRole('button', { name: 'rocket', exact: true })
    .click()
  await expect.poll(async () => (await state())?.marker).toBe('🚀')
})

test('stop a newly created service lane', async ({ parity: { page, daemon } }) => {
  const id = await startLane(page, daemon)
  await clickLaneMenu(page, daemon, id, 'Stop')
  await expect
    .poll(
      async () => (await serviceView(page, daemon))?.lanes.find((l) => l.laneId === id)?.activity,
    )
    .toBe('stopped')
})

test('archive a stopped service lane', async ({ parity: { page, daemon } }) => {
  const [saved] = (await serviceView(page, daemon))!.lanes
  await clickLaneMenu(page, daemon, saved!.laneId, 'Archive')
  await page.getByRole('button', { name: 'Archive lane', exact: true }).click()
  await expect.poll(async () => (await serviceView(page, daemon))!.lanes.length).toBe(0)
  const archives = await page.evaluate(() =>
    window.phosphor.invoke('ops:run', { kind: 'local' }, { op: 'archive.list', args: {} }),
  )
  expect(archives).toMatchObject({
    status: 'ok',
    data: { entries: [{ cwd: saved!.cwd, state: 'archived' }] },
  })
})
