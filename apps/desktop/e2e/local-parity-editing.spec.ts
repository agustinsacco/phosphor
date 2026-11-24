import { expect } from '@playwright/test'
import { test, sidebar, laneRow, savedTitle, serviceView } from './fixtures/local-parity'

test('inspect a stopped service conversation whose first entry names the lane', async ({
  parity: { page, daemon },
}) => {
  const before = (await serviceView(page, daemon))!.lanes[0]!
  const row = laneRow(page, daemon, before.laneId)
  await row.click({ button: 'right' })
  await page.getByTestId('context-menu').getByRole('button', { name: 'Session tree…' }).click()
  await expect(
    page
      .locator('[data-tooltip="Inspect tree node"]')
      .filter({ hasText: /keep this conversation/ }),
  ).toBeVisible()
})

test('clone a stopped service lane into a distinct stopped lane', async ({
  parity: { page, daemon },
}) => {
  const before = (await serviceView(page, daemon))!.lanes[0]!
  const row = laneRow(page, daemon, before.laneId)
  expect(before.activity).toBe('stopped')
  await row.click({ button: 'right' })
  await page.getByTestId('context-menu').getByRole('button', { name: 'Clone', exact: true }).click()
  await expect
    .poll(async () =>
      (await serviceView(page, daemon))!.lanes.filter((l) => l.laneId !== before.laneId),
    )
    .toMatchObject([{ activity: 'stopped', cwd: before.cwd }])
  await expect(sidebar(page).getByTestId('remote-session-row')).toHaveCount(2)
})

test('rewind a stopped service lane without changing its original conversation', async ({
  parity: { page, daemon },
}) => {
  const [original] = (await serviceView(page, daemon))!.lanes
  expect(original!.activity).toBe('stopped')
  await laneRow(page, daemon, original!.laneId).click()
  const text = `${savedTitle}: keep this conversation.`
  await page.getByTestId('user-message').filter({ hasText: text }).hover()
  await page.getByRole('button', { name: 'Rewind to here', exact: true }).click()
  await expect
    .poll(async () =>
      (await serviceView(page, daemon))!.lanes.find((l) => l.rewoundFrom === original!.laneId),
    )
    .toMatchObject({ activity: 'stopped', cwd: original!.cwd })
  const tree = await page.evaluate(
    (ref) =>
      window.phosphor.invoke('ops:run', { kind: 'local' }, { op: 'lane.tree', args: { ref } }),
    original!.laneId,
  )
  expect(tree.status).toBe('ok')
  expect(JSON.stringify(tree)).toContain(text)
})
