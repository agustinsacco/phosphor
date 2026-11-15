import type { Page } from '@playwright/test'
import { test, expect } from './fixture'

/*
 * "Move to…" from the browser, against the real Host: the fixture has one Host,
 * so this moves a lane into another folder of it. Both ends are Hosts, so the
 * page relays the bundle through its memory, as it does between two Hosts.
 */

const TITLE = 'Synthetic acceptance lane'

/**
 * A plain folder in the Host's home, configured as a workspace, through the adapter's real IPC.
 * Host folder paths are home-relative: the home itself is `''`.
 */
function addFolder(page: Page, hostId: string, name: string) {
  return page.evaluate(
    async ([host, folder]) => {
      await window.phosphor.invoke('hosts:createFolder', host!, folder!)
      return (await window.phosphor.invoke('hosts:addRepository', host!, folder!)).repositoryId
    },
    [hostId, name],
  )
}
function lanes(page: Page, hostId: string) {
  return page.evaluate(
    async (host) => (await window.phosphor.invoke('hosts:snapshot'))[host]?.lanes ?? [],
    hostId,
  )
}

test('a browser moves a Host lane into another folder of the Host', async ({
  page,
  stack,
  browserName,
}, info) => {
  await page.goto(stack.origin)
  await page.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click()
  await expect(page.getByTestId('home-board')).toBeVisible()
  const target = await addFolder(page, stack.hostId, 'moved')
  await page.goto(`${stack.origin}/lanes/${stack.hostId}/${stack.laneId}/chat`)
  // The lane is idle but open: moving stops it first, which takes control.
  await page.getByRole('button', { name: 'Take control', exact: true }).click()
  await expect(page.getByText('Controlled by you', { exact: true })).toBeVisible()

  // Wide: the sidebar row's menu opens the dialog, which offers Hosts only.
  await page.setViewportSize({ width: 1100, height: 850 })
  await page.getByTestId('remote-session-row').filter({ hasText: TITLE }).click({ button: 'right' })
  await page
    .getByTestId('context-menu')
    .getByRole('button', { name: /^Move to…/ })
    .click()
  const dialog = page.locator('[data-modal-overlay]')
  await expect(dialog.getByText('Move lane', { exact: true })).toBeVisible()
  const machine = dialog.getByRole('combobox', { name: 'Machine', exact: true })
  await expect(machine.locator('option')).toHaveCount(1)
  await expect(machine.locator('option')).not.toHaveText(/This Mac/)
  await dialog
    .getByRole('combobox', { name: 'Workspace', exact: true })
    .selectOption({ label: 'moved' })
  await expect(dialog.getByText(/KB to copy\./)).toBeVisible()
  await expect(dialog.getByText(/passes through this device/)).toBeVisible()
  await page.screenshot({ path: info.outputPath('lane-move-wide-1100.png') })
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click()
  await expect(dialog).toHaveCount(0)

  // Phone: the lane header's sheet; the dialog is the compact sheet, and the move runs.
  await page.setViewportSize({ width: 400, height: 850 })
  await page.getByRole('button', { name: `Lane menu, ${TITLE}`, exact: true }).click()
  await page
    .getByRole('group', { name: 'Lane actions', exact: true })
    .getByRole('button', { name: /^Move to…/ })
    .click()
  await expect(page.locator('[data-modal-overlay][data-compact-sheet]')).toBeVisible()
  const workspace = dialog.getByRole('combobox', { name: 'Workspace', exact: true })
  expect(await workspace.evaluate((select) => getComputedStyle(select).fontSize)).toBe('16px')
  // The compact 44px min-height; macOS WebKit draws a native select at its own height.
  if (browserName === 'chromium')
    expect((await workspace.boundingBox())!.height).toBeGreaterThanOrEqual(44)
  await workspace.selectOption({ label: 'moved' })
  await expect(
    dialog.getByText('The conversation moves into this folder.', { exact: false }),
  ).toBeVisible()
  await dialog.getByRole('checkbox', { name: /I understand this uses the target/ }).check()
  const move = dialog.getByRole('button', { name: 'Move', exact: true })
  await expect(move).toBeInViewport()
  // One column on the phone: nothing scrolls sideways.
  expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(400)
  await page.screenshot({ path: info.outputPath('lane-move-phone-400.png') })
  await move.click()
  await expect(dialog.getByText(/^Moved to .+ · moved\./)).toBeVisible({ timeout: 30_000 })

  await expect.poll(async () => (await lanes(page, stack.hostId)).length).toBe(3)
  const all = await lanes(page, stack.hostId)
  const copy = all.find((lane) => lane.repositoryId === target)!
  expect(copy.title).toBe(TITLE)
  // The original stays, and the copy waits to be opened.
  expect(all.map((lane) => lane.laneId)).toContain(stack.laneId)
  expect(copy.activity).toBe('stopped')
  await dialog.getByRole('button', { name: 'Open', exact: true }).click()
  await expect(page).toHaveURL(new RegExp(`/lanes/${stack.hostId}/${copy.laneId}`))
  await expect(dialog).toHaveCount(0)
})
