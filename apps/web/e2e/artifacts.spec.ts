import type { Page } from '@playwright/test'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { test, expect } from './fixture'

async function openArtifacts(page: Page, origin: string, width: number) {
  await page.setViewportSize({ width, height: 850 })
  await page.goto(origin)
  await page.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click()
  await page
    .getByTestId('home-board')
    .getByRole('button', { name: 'Synthetic acceptance lane', exact: true })
    .click()
  await page.getByRole('button', { name: 'Take control', exact: true }).click()
  await expect(page.getByText('Controlled by you', { exact: true })).toBeVisible()
  const chat = page.getByRole('textbox', { name: 'Chat message', exact: true })
  await chat.fill('artifact version two')
  await page.getByRole('button', { name: 'Send message', exact: true }).click()
  if (width < 900) await page.getByRole('button', { name: /^Lane menu/ }).click()
  await page
    .getByRole('navigation', { name: 'Lane panes' })
    .getByRole('button', { name: 'Artifacts', exact: true })
    .click()
  await expect(page.getByRole('combobox', { name: 'Version', exact: true })).toHaveValue('2')
}
async function changeView(page: Page, width: number, view: 'Diff' | 'Preview') {
  if (width < 900)
    await page.getByRole('combobox', { name: 'View', exact: true }).selectOption(view.toLowerCase())
  else await page.getByRole('button', { name: view, exact: true }).click()
}
async function touchControls(page: Page) {
  for (const name of ['View', 'Version', 'Download source', 'Artifact actions']) {
    const control = page.getByRole(name === 'View' || name === 'Version' ? 'combobox' : 'button', {
      name,
      exact: true,
    })
    expect(
      await control.evaluate((node) => {
        const box = node.getBoundingClientRect()
        return [-21, 21].every((dy) =>
          node.contains(
            document.elementFromPoint(box.left + box.width / 2, box.top + box.height / 2 + dy),
          ),
        )
      }),
    ).toBe(true)
  }
}

for (const width of [400, 1100])
  test(`Host artifacts compare versions, download raw HTML and write into Files at ${width}px`, async ({
    page,
    stack,
  }) => {
    await openArtifacts(page, stack.origin, width)
    const preview = page.frameLocator('iframe')
    await expect(preview.getByRole('heading', { name: 'HOST_A_ONLY version 2' })).toBeVisible()
    await expect(page.locator('iframe')).toHaveAttribute('sandbox', '')
    await expect(page.getByRole('button', { name: /PDF/ })).toHaveCount(0)
    if (width < 900) await touchControls(page)
    await changeView(page, width, 'Diff')
    const diff = page.locator(width < 900 ? '[aria-label="Unified diff"]' : '.monaco-diff-editor')
    await expect(diff).toContainText('HOST_A_ONLY version 1')
    await expect(diff).toContainText('HOST_A_ONLY version 2')
    await page.getByRole('combobox', { name: 'Version', exact: true }).selectOption('1')
    const download = page.waitForEvent('download')
    await page.getByRole('button', { name: 'Download source', exact: true }).click()
    const saved = await download
    expect(saved.suggestedFilename()).toBe('host-card.html')
    expect(await readFile((await saved.path())!, 'utf8')).toBe('<h1>HOST_A_ONLY version 1</h1>')
    await page.getByRole('combobox', { name: 'Version', exact: true }).selectOption('2')
    if (width < 900) {
      await page.getByRole('button', { name: 'Artifact actions', exact: true }).click()
      await expect(
        page.getByRole('dialog', { name: 'Artifact actions', exact: true }),
      ).toBeVisible()
    }
    await page
      .getByRole('button', {
        name: width < 900 ? 'Write in Files' : 'Write into workspace and open in Files',
        exact: true,
      })
      .click()
    await expect
      .poll(() => readFile(join(stack.repository, 'host-card.html'), 'utf8').catch(() => null))
      .toBe('<h1>HOST_A_ONLY version 2</h1>')
    await expect(page.getByTestId('artifact-scroll')).toHaveCount(0)
    // Files opens HTML on its static preview; Source reads the same saved bytes.
    await expect(
      page.frameLocator('iframe').getByRole('heading', { name: 'HOST_A_ONLY version 2' }),
    ).toBeVisible()
    await page.getByRole('button', { name: 'Source', exact: true }).click()
    // A phone's Files opens the written file as its detail, not behind the tree.
    await expect(
      page.locator(width < 900 ? '.code-block' : '.monaco-editor .view-lines').first(),
    ).toContainText('HOST_A_ONLY version 2')
  })
