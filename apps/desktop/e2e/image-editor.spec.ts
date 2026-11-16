import { test, expect } from '@playwright/test'
import { launch, openWorkspace, shutdown } from './fixtures/local-app'

test('canvas annotation keeps Desktop mouse drawing, undo and replace-original', async () => {
  const harness = await launch()
  const { page } = harness
  try {
    await openWorkspace(page)
    // Synthetic paste exercises attachments without touching the shared system clipboard.
    await page.evaluate(() => {
      const canvas = document.createElement('canvas')
      canvas.width = 300
      canvas.height = 200
      const ctx = canvas.getContext('2d')!
      ctx.fillStyle = '#ffffff'
      ctx.fillRect(0, 0, 300, 200)
      const bytes = Uint8Array.from(atob(canvas.toDataURL('image/png').split(',')[1]!), (c) =>
        c.charCodeAt(0),
      )
      const clipboardData = new DataTransfer()
      clipboardData.items.add(new File([bytes], 'test.png', { type: 'image/png' }))
      document
        .querySelector('textarea')!
        .dispatchEvent(
          new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData }),
        )
    })
    const chips = page.getByTestId('attachment-chips')
    const original = await chips.locator('img').getAttribute('src')
    await chips.getByRole('button', { name: 'Attached image', exact: true }).click()
    const editor = page.getByRole('dialog', { name: 'Annotate image' })
    const canvas = page.getByTestId('image-editor-canvas')
    await expect(canvas).toBeVisible()
    const box = (await canvas.boundingBox())!
    await page.mouse.move(box.x + box.width * 0.2, box.y + box.height * 0.2)
    await page.mouse.down()
    await page.mouse.move(box.x + box.width * 0.7, box.y + box.height * 0.7, { steps: 6 })
    await page.mouse.up()
    await expect(editor.getByRole('button', { name: 'Undo', exact: true })).toBeEnabled()
    await editor.getByRole('button', { name: 'Undo', exact: true }).click()
    await expect(editor.getByRole('button', { name: 'Undo', exact: true })).toBeDisabled()
    await editor.getByRole('button', { name: 'Redo', exact: true }).click()
    await expect(editor.getByLabel('Replace original')).toBeChecked()
    await editor.getByRole('button', { name: 'Done', exact: true }).click()
    await expect(editor).toBeHidden()
    await expect(chips.locator('img')).toHaveCount(1)
    expect(await chips.locator('img').getAttribute('src')).not.toBe(original)
    await page.getByRole('button', { name: 'Start lane', exact: true }).click()
    await expect(chips).toHaveCount(0)
    await expect(page.getByRole('img', { name: 'Attached image', exact: true })).toBeVisible()
    await page.getByRole('button', { name: 'Attached image', exact: true }).click()
    await expect(
      page.getByRole('img', { name: 'Attached image, full size', exact: true }),
    ).toBeVisible()
    await expect(page.getByRole('button', { name: 'Save image', exact: true })).toHaveCount(0)
  } finally {
    await shutdown(harness)
  }
})
