import { expect } from '@playwright/test'
import type { remoteHostFixture } from './remote-host'

export type RemoteFixture = Awaited<ReturnType<typeof remoteHostFixture>>

export async function openRemote(h: RemoteFixture, title = 'Remote test lane') {
  h.page.setDefaultTimeout(4000)
  const switcher = h.page.getByRole('button', { name: 'Machine filter', exact: true })
  await switcher.click()
  await h.page.getByRole('option').filter({ hasText: 'bee1' }).click()
  await h.page
    .getByRole('region', { name: 'bee1', exact: true })
    .getByRole('button', { name: new RegExp(title) })
    .click()
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
  await h.page.getByRole('button', { name: /^Files pane/ }).click()
}

export async function file(h: RemoteFixture, name: string) {
  await h.page
    .getByRole('button', { name: new RegExp(`(?:^|\\s)${name.replaceAll('.', '\\.')}$$`) })
    .click()
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
  await input.focus()
  await input.press('ControlOrMeta+A')
  // One text-input event avoids cursor moves between React's controlled-value updates.
  await h.page.keyboard.insertText(content)
  await expect(h.page.locator('.monaco-editor .view-lines').first()).toContainText(content)
  await expect(h.page.getByRole('button', { name: 'Save', exact: true })).toBeEnabled({
    timeout: 3000,
  })
}
