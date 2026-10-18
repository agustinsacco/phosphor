import { expect, type TestInfo } from '@playwright/test'
import type { remoteHostFixture } from './remote-host'

export type RemoteFixture = Awaited<ReturnType<typeof remoteHostFixture>>

export async function openMachineSettings(h: RemoteFixture, section = 'Providers') {
  if (!(await h.page.getByTestId('machines-page').isVisible()))
    await h.page.getByRole('button', { name: 'Machines', exact: true }).click()
  await expect(h.page.getByTestId('machines-page')).toBeVisible()
  await expect
    .poll(
      async () =>
        (await h.page.getByTestId('machine-detail').count()) +
        (await h.page.getByTestId('enrolled-machine-row').count()),
    )
    .toBeGreaterThan(0)
  if (await h.page.getByTestId('enrolled-machine-row').count())
    await h.page.getByTestId('enrolled-machine-row').click()
  await h.page.getByRole('button', { name: 'Machine settings', exact: true }).click()
  const settings = h.page.getByTestId('machine-settings')
  await expect
    .poll(
      async () =>
        (await h.page.evaluate(() => window.phosphor.invoke('hosts:snapshot')))[h.hostId]?.state,
    )
    .toBe('ready')
  const snapshot = await h.page.evaluate(() => window.phosphor.invoke('hosts:snapshot'))
  if (!snapshot[h.hostId]?.capabilities.includes('machine.configure')) {
    await settings.getByRole('button', { name: 'Enable configuration access', exact: true }).click()
    await h.page.getByRole('button', { name: 'Enable for bee1', exact: true }).click()
  }
  await settings
    .getByRole('navigation', { name: 'Machine settings', exact: true })
    .getByRole('button', { name: 'Providers', exact: true })
    .click()
  await expect(settings.getByRole('heading', { name: 'Providers', exact: true })).toBeVisible({
    timeout: 30_000,
  })
  if (section !== 'Providers')
    await settings
      .getByRole('navigation', { name: 'Machine settings', exact: true })
      .getByRole('button', { name: section, exact: true })
      .click()
  await expect(settings.getByRole('heading', { name: section, exact: true })).toBeVisible()
  return settings
}

export async function openRemote(h: RemoteFixture, title = 'Remote test lane') {
  const switcher = h.page.getByRole('button', { name: 'Machine filter', exact: true })
  await switcher.click()
  await h.page.getByRole('option').filter({ hasText: 'bee1' }).click()
  await selectLane(h, title)
}

export async function takeControl(h: RemoteFixture) {
  await h.page.getByRole('button', { name: 'Take control', exact: true }).click()
  await expect(h.page.getByText('Controlled by you', { exact: true })).toBeVisible()
}

export async function sendTurn(h: RemoteFixture, value: string, reply = value) {
  const composer = h.page.getByRole('textbox', { name: 'Chat message', exact: true })
  const before = await h.page.locator('main').getByText(reply, { exact: true }).count()
  await composer.fill(value)
  await composer.press('Enter')
  await expect(h.page.locator('main').getByText(reply, { exact: true })).toHaveCount(
    before + (value === reply ? 2 : 1),
  )
  await expect(h.page.locator('button[aria-label="Stop"]')).toBeHidden()
}

export async function files(h: RemoteFixture) {
  await pane(h, 'Files')
  await expect(h.page.getByText('Explorer', { exact: true })).toBeVisible()
}

export function fileRow(h: RemoteFixture, name: string) {
  const parts = name.split('/')
  const basename = parts.at(-1) ?? name
  let row = h.page
    .getByRole('treeitem', { name: new RegExp(`^${basename.replaceAll('.', '\\.')}(( )|$)`) })
    .and(h.page.locator(`[aria-level="${parts.length}"]`))
  if (parts.length > 1) {
    row = row.filter({
      has: h.page
        .locator(
          `xpath=preceding-sibling::*[@role="treeitem" and @aria-level="${parts.length - 1}"][1]`,
        )
        .filter({ hasText: parts.at(-2) }),
    })
  }
  return row
}

export async function file(h: RemoteFixture, name: string) {
  const row = fileRow(h, name)
  await row.click()
  await expect(row).toHaveClass(/bg-accent-soft/)
}

export async function pathPrompt(h: RemoteFixture, action: string, path: string) {
  await h.page.getByRole('button', { name: action, exact: true }).click()
  const dialog = h.page.getByRole('dialog')
  await dialog.getByRole('textbox').fill(path)
  await dialog.getByRole('button', { name: 'OK', exact: true }).click()
  await expect(dialog).toBeHidden()
  await expect(h.page.getByRole('button', { name: 'New file', exact: true })).toBeEnabled()
}

export async function edit(h: RemoteFixture, content: string) {
  const input = h.page.locator('.monaco-editor [role="textbox"]').first()
  await expect(input).toBeEditable()
  await input.focus()
  await expect(input).toBeFocused()
  await input.press('ControlOrMeta+A')
  // One text-input event avoids cursor moves between React's controlled-value updates.
  await h.page.keyboard.insertText(content)
  await expect(h.page.locator('.monaco-editor .view-lines').first()).toContainText(content)
  await expect(h.page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled()
}

export async function selectMachine(h: RemoteFixture, name: string) {
  await h.page.getByRole('button', { name: 'Machine filter', exact: true }).first().click()
  await h.page.getByRole('option').filter({ hasText: name }).click()
}

export function remoteRow(h: RemoteFixture, title = 'Remote test lane') {
  return h.page
    .getByRole('region', { name: 'bee1', exact: true })
    .getByRole('button', { name: new RegExp(title) })
}

export async function captures(h: Pick<RemoteFixture, 'page'>, info: TestInfo, name: string) {
  const { mkdir, copyFile } = await import('node:fs/promises')
  const { join } = await import('node:path')
  // Captures always attach to the test report. PHOSPHOR_E2E_SHOTS optionally copies them
  // to one folder for side-by-side review.
  const destination = process.env.PHOSPHOR_E2E_SHOTS
  if (destination) await mkdir(destination, { recursive: true })
  for (const theme of ['light', 'dark'] as const) {
    await h.page.evaluate(async (theme) => {
      await window.phosphor.invoke('app:setTheme', theme)
      document.documentElement.classList.toggle('dark', theme === 'dark')
      await document.fonts.ready
    }, theme)
    const filename = `${name}-${theme}.png`
    const path = info.outputPath(filename)
    await h.page.screenshot({ path, animations: 'disabled' })
    if (destination) await copyFile(path, join(destination, filename))
    await info.attach(filename, { path, contentType: 'image/png' })
  }
}

export async function pane(h: RemoteFixture, name: string) {
  const button = h.page.getByRole('button', { name: new RegExp(`^${name} pane`) })
  if (!(await button.getAttribute('class'))?.includes('bg-accent-soft')) await button.click()
}

export async function selectLane(h: RemoteFixture, title: string) {
  await remoteRow(h, title).click()
  await expect(h.page.getByRole('banner')).toContainText(
    title === 'Untitled lane' ? 'New session' : title,
  )
}
