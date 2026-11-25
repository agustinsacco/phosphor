import { expect } from '@playwright/test'
import { appendFile } from 'node:fs/promises'
import { laneRow, serviceView, test } from './fixtures/local-parity'

test('keeps an oversized service lane open after warm-on-open starts pi', async ({
  parity: { page, daemon, transcript },
}) => {
  // A real pi entry, too large for either the stopped or the live frame.
  await appendFile(
    transcript,
    JSON.stringify({
      type: 'message',
      id: 'large',
      parentId: 'saved-card',
      message: { role: 'user', content: 'x'.repeat(17 * 1024 * 1024) },
    }) + '\n',
  )
  const [lane] = (await serviceView(page, daemon))!.lanes
  expect(lane!.activity).toBe('stopped')
  const row = laneRow(page, daemon, lane!.laneId)
  await row.click()
  await expect.poll(async () => (await serviceView(page, daemon))!.lanes[0]?.activity).toBe('idle')
  await expect(row).toHaveAttribute('aria-current', 'page')
  await expect(
    page.getByText('This conversation is too large to preview.', { exact: true }),
  ).toBeVisible()
  await expect(page.getByText('Describe a task to begin')).toHaveCount(0)

  await expect(page.getByText('Could not open the remote lane.', { exact: true })).toHaveCount(0)
  await expect(page.getByText('pi crashed', { exact: true })).toHaveCount(0)
})
