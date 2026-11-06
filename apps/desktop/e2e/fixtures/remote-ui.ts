import { expect, type Locator, type TestInfo } from '@playwright/test'
import type { remoteHostFixture } from './remote-host'

export type RemoteFixture = Awaited<ReturnType<typeof remoteHostFixture>>

/**
 * Opens bee1's Settings from its Machines page entry, enables configuration
 * access when needed and opens `section`; `heading` is what its panel shows.
 * Returns the Settings dialog.
 */
export async function openMachineSettings(
  h: RemoteFixture,
  section = 'Accounts',
  heading = section,
) {
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
  const settings = h.page.getByRole('dialog', { name: 'Settings', exact: true })
  await expect(settings.getByTestId('settings-machine-scope')).toContainText('Configuring bee1')
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
  await openSettingsSection(settings, 'Accounts')
  await expect(settings.getByRole('heading', { name: 'Accounts', exact: true })).toBeVisible({
    timeout: 30_000,
  })
  if (section !== 'Accounts') await openSettingsSection(settings, section)
  await expect(settings.getByRole('heading', { name: heading, exact: true })).toBeVisible()
  return settings
}

/** One section from the Settings navigation. */
export async function openSettingsSection(settings: Locator, name: string) {
  await settings
    .getByRole('navigation', { name: 'Settings sections', exact: true })
    .getByRole('button', { name, exact: true })
    .click()
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

/** The explorer row for a lane-relative path; its data-path is `host:<id>/lane:<id>/<path>`. */
export function fileRow(h: RemoteFixture, name: string) {
  return h.page
    .getByTestId('right-pane')
    .getByTestId('file-explorer')
    .locator(`xpath=.//*[substring-after(substring-after(@data-path, "/lane:"), "/") = "${name}"]`)
}

/** Opens a file from the explorer, expanding its folders first. */
export async function file(h: RemoteFixture, name: string) {
  const parts = name.split('/')
  for (let i = 1; i < parts.length; i++) {
    const folder = fileRow(h, parts.slice(0, i).join('/'))
    if ((await folder.getAttribute('aria-expanded')) !== 'true') await folder.click()
  }
  const row = fileRow(h, name)
  await row.click()
  await expect(row).toHaveAttribute('aria-current', 'true')
}

/** New file or folder from the explorer header, in the selected folder or the root. */
export async function create(h: RemoteFixture, kind: 'file' | 'folder', name: string) {
  await h.page.getByRole('button', { name: `New ${kind}`, exact: true }).click()
  await answerPrompt(h, name)
  await expect(fileRow(h, name)).toBeVisible()
}

/** One item of a row's context menu. */
export async function rowMenu(h: RemoteFixture, name: string, item: string) {
  await fileRow(h, name).click({ button: 'right' })
  await h.page.getByTestId('context-menu').getByRole('button', { name: item, exact: true }).click()
}

export async function rename(h: RemoteFixture, name: string, to: string) {
  await rowMenu(h, name, 'Rename…')
  await answerPrompt(h, to)
}

export async function trash(h: RemoteFixture, name: string) {
  await rowMenu(h, name, 'Delete')
  await h.page
    .getByRole('dialog')
    .getByRole('button', { name: 'Move to Trash', exact: true })
    .click()
  await expect(fileRow(h, name)).toHaveCount(0)
}

/** Drags an entry onto a folder: a move, or a copy with Option/Ctrl held. */
export async function dropInto(h: RemoteFixture, name: string, folder: string, copy = false) {
  const modifier = process.platform === 'darwin' ? 'Alt' : 'Control'
  if (copy) await h.page.keyboard.down(modifier)
  try {
    await fileRow(h, name).dragTo(fileRow(h, folder))
  } finally {
    if (copy) await h.page.keyboard.up(modifier)
  }
}

async function answerPrompt(h: RemoteFixture, value: string) {
  const dialog = h.page.getByRole('dialog')
  await dialog.getByRole('textbox').fill(value)
  await dialog.getByRole('button', { name: 'OK', exact: true }).click()
  await expect(dialog).toBeHidden()
}

/** Cmd/Ctrl+S in the active editor, as on This Mac. */
export async function save(h: RemoteFixture) {
  const input = h.page.getByTestId('right-pane').locator('.monaco-editor [role="textbox"]').first()
  await input.focus()
  await h.page.keyboard.press('ControlOrMeta+KeyS')
}

/** The active tab's unsaved-edits dot. */
export function unsaved(h: RemoteFixture) {
  return h.page
    .getByTestId('right-pane')
    .getByRole('tab', { selected: true })
    .locator('.rounded-full')
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
  await expect(unsaved(h)).toBeVisible()
}

export async function selectMachine(h: RemoteFixture, name: string) {
  await h.page.getByRole('button', { name: 'Machine filter', exact: true }).first().click()
  await h.page.getByRole('option').filter({ hasText: name }).click()
}

/**
 * bee1's lanes in the sidebar. Host home lists the same folders and lanes under its
 * composer, so a folder control or row looked up outside this region matches twice.
 */
export function sidebarHost(h: RemoteFixture) {
  return h.page.getByRole('region', { name: 'bee1', exact: true })
}

export function remoteRow(h: RemoteFixture, title = 'Remote test lane') {
  return sidebarHost(h).getByRole('button', { name: new RegExp(title) })
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
