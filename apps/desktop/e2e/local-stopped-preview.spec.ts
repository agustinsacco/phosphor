import { expect } from '@playwright/test'
import { truncate } from 'node:fs/promises'
import { laneRow, serviceView, test } from './fixtures/local-parity'

test('opens a stopped service lane even when its transcript exceeds the preview limit', async ({
  parity: { page, daemon, transcript },
}) => {
  // A sparse extension of the scratch fixture leaves its header intact but adds
  // one line larger than the reader can index. Do not start pi to get a preview.
  await truncate(transcript, 33 * 1024 * 1024)
  const [lane] = (await serviceView(page, daemon))!.lanes
  const row = laneRow(page, daemon, lane!.laneId)
  await row.click()
  await expect(row).toHaveAttribute('aria-current', 'page')
  await expect(
    page.getByText('This conversation is too large to preview while stopped. Resume to load it.', {
      exact: true,
    }),
  ).toBeVisible()
  await expect(page.getByRole('button', { name: 'Resume', exact: true })).toBeEnabled()
  await expect(page.getByText('Could not open the remote lane.', { exact: true })).toHaveCount(0)
  expect((await serviceView(page, daemon))!.lanes[0]?.activity).toBe('stopped')
})
