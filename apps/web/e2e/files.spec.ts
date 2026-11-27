import type { Locator, Page } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, expect } from './fixture'

/** A 1×1 PNG: the smallest image a browser decodes, so a refused blob: shows as 0×0. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==',
  'base64',
)
const phone = (page: Page) => (page.viewportSize()?.width ?? 400) < 900

async function openFiles(page: Page, origin: string, control: boolean) {
  await page.goto(origin)
  await page.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click()
  await expect(page.getByTestId('compact-shell')).toBeVisible()
  // The home board lists the lane at both widths; a wide window's column lists it too.
  await page
    .getByTestId('home-board')
    .getByRole('button', { name: 'Synthetic acceptance lane', exact: true })
    .click()
  await expect(page.getByText('Nobody has control of this lane.', { exact: true })).toBeVisible()
  if (control) {
    await page.getByRole('button', { name: 'Take control', exact: true }).click()
    await expect(page.getByText('Controlled by you', { exact: true })).toBeVisible()
  }
  if (phone(page)) await page.getByRole('button', { name: /^Lane menu/ }).click()
  await page
    .getByRole('navigation', { name: 'Lane panes' })
    .getByRole('button', { name: 'Files', exact: true })
    .click()
}
/** The explorer row for a lane-relative path; a phone keeps the tree mounted behind a file. */
function fileRow(page: Page, path: string) {
  return page.locator(`[data-testid="file-explorer"] [data-path$="/${path}"]`)
}
/**
 * The editor's Mod key, read as Monaco reads it (`CtrlCmd`): Meta where the browser's user agent
 * names a Mac, else Control, so the spec presses what a user of that browser presses. Not
 * Playwright's ControlOrMeta, which follows the machine running the test: Playwright's WebKit
 * reports a Mac Safari user agent on every OS, so on Linux that pressed Control+S into an
 * editor bound to Cmd+S. A real browser's user agent names its own OS.
 */
async function modKey(page: Page): Promise<'Meta' | 'Control'> {
  return (await page.evaluate(() => navigator.userAgent.includes('Macintosh'))) ? 'Meta' : 'Control'
}
/** Replace the open file's text: a phone's plain field after Edit, Monaco when wide. */
async function edit(page: Page, content: string) {
  if (phone(page)) {
    const field = page.getByRole('textbox', { name: 'Edit remote.txt', exact: true })
    if (!(await field.isVisible()))
      await page.getByRole('button', { name: 'Edit', exact: true }).click()
    await field.fill(content)
    return
  }
  const input = page.locator('.monaco-editor [role="textbox"]').first()
  await expect(input).toBeEditable()
  await input.focus()
  await input.press(`${await modKey(page)}+KeyA`)
  await page.keyboard.insertText(content)
  // The whole text: a missed select-all leaves the old text after the new.
  await expect(page.locator('.monaco-editor .view-lines').first()).toHaveText(content)
}
async function save(page: Page) {
  if (phone(page)) await page.getByRole('button', { name: 'Save', exact: true }).click()
  else
    await page
      .locator('.monaco-editor [role="textbox"]')
      .first()
      .press(`${await modKey(page)}+KeyS`)
}
/**
 * A phone's tap lands on the control anywhere in a 44px band across its middle, through its
 * own box or its hit-slop, with none of the band clipped away by a container.
 */
async function expectTouchTarget(control: Locator) {
  const reach = await control.evaluate((node) => {
    const box = node.getBoundingClientRect()
    const [x, y] = [box.left + box.width / 2, box.top + box.height / 2]
    return [-21, 21].map((dy) => node.contains(document.elementFromPoint(x, y + dy)))
  })
  expect(reach).toEqual([true, true])
}
/** What the open file shows: the phone's highlighted read view, or Monaco. */
const shown = (page: Page) =>
  page.locator(phone(page) ? '.code-block' : '.monaco-editor .view-lines').first()

for (const width of [400, 1100])
  test(`a controller edits and saves a Host lane's file, keeping a conflicting edit, at ${width}px`, async ({
    page,
    stack,
  }) => {
    await page.setViewportSize({ width, height: 850 })
    const remote = join(stack.repository, 'remote.txt')
    await openFiles(page, stack.origin, true)
    await fileRow(page, 'remote.txt').click()
    await expect(shown(page)).toContainText('HOST_A_ONLY synthetic file')
    if (phone(page))
      for (const name of ['← Files', 'Edit'])
        await expectTouchTarget(page.getByRole('button', { name, exact: true }))
    await edit(page, 'HOST_A_ONLY saved from a browser')
    await save(page)
    await expect.poll(() => readFile(remote, 'utf8')).toBe('HOST_A_ONLY saved from a browser')

    // Saves carry the revision the editor read: a competing write is never overwritten.
    await edit(page, 'HOST_A_ONLY browser draft')
    await writeFile(remote, 'HOST_A_ONLY competing write')
    await save(page)
    await expect(page.getByText('File changed on disk while you had unsaved edits.')).toBeVisible()
    expect(await readFile(remote, 'utf8')).toBe('HOST_A_ONLY competing write')
    await page.getByRole('button', { name: 'Reload', exact: true }).click()
    if (phone(page)) await page.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(shown(page)).toContainText('HOST_A_ONLY competing write')
    if (phone(page)) {
      // A phone's file is its own screen; Back returns to the tree.
      await page.getByRole('button', { name: '← Files', exact: true }).click()
      await expect(fileRow(page, 'remote.txt')).toBeVisible()
    }
  })

for (const width of [400, 1100])
  test(`a reader previews a Host image from its bytes and downloads a file, at ${width}px`, async ({
    page,
    stack,
  }) => {
    await page.setViewportSize({ width, height: 850 })
    await writeFile(join(stack.repository, 'pixel.png'), PIXEL)
    const refused: string[] = []
    page.on('console', (message) => {
      // Only the previews' own refusals: this checks img-src/media-src, not the fonts.
      if (
        /Content Security|Content-Security|Refused/i.test(message.text()) &&
        /blob:/.test(message.text())
      )
        refused.push(message.text().slice(0, 300))
    })
    await openFiles(page, stack.origin, false)
    await fileRow(page, 'pixel.png').click()
    const image = page.getByRole('img', { name: 'pixel.png', exact: true })
    await expect(image).toHaveAttribute('src', /^blob:/)
    // The app's CSP admits blob: images; a refused one never decodes.
    await expect.poll(() => image.evaluate((img: HTMLImageElement) => img.naturalWidth)).toBe(1)

    const action = page.getByRole('button', { name: 'Download', exact: true })
    if (phone(page)) await expectTouchTarget(action)
    const download = page.waitForEvent('download')
    await action.click()
    const saved = await download
    expect(saved.suggestedFilename()).toBe('pixel.png')
    expect(await readFile((await saved.path())!)).toEqual(PIXEL)
    // A browser download hands its bytes to the browser: no Open or Reveal.
    const row = page
      .getByRole('listitem')
      .filter({ has: page.getByText('Downloaded', { exact: true }) })
    await expect(row.getByRole('button')).toHaveCount(1)
    await expect(row.getByRole('button', { name: 'Dismiss pixel.png', exact: true })).toBeVisible()
    expect(refused).toEqual([])
  })
