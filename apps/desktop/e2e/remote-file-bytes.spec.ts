import { test, expect } from '@playwright/test'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { REMOTE_TEST_TIMEOUT, remoteHostFixture } from './fixtures/remote-host'
import { file, files, openRemote, rowMenu } from './fixtures/remote-ui'

/** A 1 × 1 PNG, so the streamed image reports its size once it has loaded. */
const PIXEL = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
  'base64',
)

test('A Host lane’s files download into Downloads and stream into the viewer', async () => {
  test.setTimeout(REMOTE_TEST_TIMEOUT)
  const h = await remoteHostFixture()
  try {
    await writeFile(join(h.repo, 'pixel.png'), PIXEL)
    await h.signIn()
    await openRemote(h)
    await files(h)
    // Reading needs no control of the lane.
    await rowMenu(h, 'binary.bin', /^Download/)
    const downloads = h.page.getByRole('list', { name: 'Downloads', exact: true })
    await expect(downloads.getByText('Saved to Downloads', { exact: true })).toBeVisible()
    expect([...(await readFile(join(h.userData, 'Downloads', 'binary.bin')))]).toEqual([0, 1, 2, 0])
    // A second copy is numbered, never replacing the first.
    await rowMenu(h, 'binary.bin', /^Download/)
    await expect(downloads.getByText('Saved to Downloads', { exact: true })).toHaveCount(2)
    await readFile(join(h.userData, 'Downloads', 'binary (2).bin'))
    // An image streams from the Host through a remote grant, not the "No preview" card.
    await file(h, 'pixel.png')
    await expect(h.page.locator('img[src^="phosphor-file://"]')).toBeVisible()
    await expect(h.page.getByText(/^1 × 1/)).toBeVisible()
  } finally {
    await h.close()
  }
})
