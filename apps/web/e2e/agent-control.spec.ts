import type { Page } from '@playwright/test'
import { READY_OP_FLAGS, type HostFrame } from '@phosphor/shared/host-protocol'
import { test, expect } from './fixture'

async function openAgent(page: Page, origin: string, hostId: string) {
  await page.goto(`${origin}/pages/settings/${hostId}`)
  const settings = page.getByTestId('settings-surface')
  await settings
    .getByRole('navigation', { name: 'Settings sections' })
    .getByRole('button', { name: 'Agent', exact: true })
    .click()
  await expect(settings.getByTestId('settings-machine-scope')).toContainText(
    'Configuring Synthetic Host',
  )
  return settings
}

async function openMachine(page: Page, origin: string) {
  await page.goto(`${origin}/pages/machines`)
  await page.getByRole('button', { name: /Synthetic Host/ }).click()
}

test('reviews and approves the exact request held by a Host announcing agent control', async ({
  page,
  stack,
}) => {
  const archive = crypto.randomUUID()
  const reason = 'Retire the synthetic archive after review.'
  const confirmId = await stack.askToPurge(archive, reason)
  await page.goto(stack.origin)
  await page.getByRole('button', { name: 'Sign in with GitHub' }).click()
  await expect(page.getByTestId('home-board')).toBeVisible()
  const settings = await openAgent(page, stack.origin, stack.hostId)
  await expect(settings.getByRole('heading', { name: 'Pending approvals' })).toBeVisible()
  await settings.getByRole('button', { name: 'Review', exact: true }).click()
  await expect(page.getByText('Requested by Synthetic requester · archive.purge')).toBeVisible()
  const message = page.locator('p').filter({ hasText: `Request ${confirmId.slice(0, 8)}` })
  await expect(message).toContainText(archive)
  await expect(message).toContainText(reason)
  await page.getByRole('button', { name: 'Approve', exact: true }).click()
  await expect(settings.getByText('No requests waiting for approval.')).toBeVisible()
  const info = await page.evaluate(
    ({ hostId, confirmId }) =>
      window.phosphor.invoke(
        'ops:run',
        { kind: 'remote', hostId },
        { op: 'confirm.info', args: { confirmId } },
      ),
    { hostId: stack.hostId, confirmId },
  )
  expect(info).toMatchObject({ status: 'ok', data: { confirmId, state: 'approved' } })
})

/** Model a rolling upgrade on the wire. Leave the real socket's authentication, proof,
 * subscriptions and calls untouched. A paused lane still has the legacy stopped activity. */
async function legacyFrames(page: Page, laneId: string) {
  const pause = { reason: 'service-update', at: new Date().toISOString() } as const
  await page.routeWebSocket('**/fixture-host', (route) => {
    const server = route.connectToServer()
    server.onMessage((raw) => {
      const frame = JSON.parse(raw.toString()) as HostFrame
      if (frame.type === 'ready') {
        const legacy = { ...frame }
        for (const flag of READY_OP_FLAGS) delete legacy[flag]
        route.send(JSON.stringify(legacy))
      } else if (frame.type === 'lanes' || frame.type === 'lanes-delta') {
        const key = frame.type === 'lanes' ? 'lanes' : 'upsert'
        const lanes = frame.type === 'lanes' ? frame.lanes : frame.upsert
        route.send(
          JSON.stringify({
            ...frame,
            [key]: lanes.map((lane) =>
              lane.laneId === laneId ? { ...lane, activity: 'stopped', pause } : lane,
            ),
          }),
        )
      } else route.send(raw)
    })
  })
  return pause
}

test('a legacy ready frame keeps lanes (including a service pause) and hides agent controls', async ({
  page,
  stack,
}) => {
  stack.state.machineReach = true // New control, but no ops on this Host.
  const pause = await legacyFrames(page, stack.laneId)
  await page.goto(stack.origin)
  await page.getByRole('button', { name: 'Sign in with GitHub' }).click()
  await expect(
    page
      .getByTestId('home-board')
      .getByRole('button', { name: 'Synthetic acceptance lane', exact: true }),
  ).toBeVisible()
  const host = await page.evaluate(
    async (id) => (await window.phosphor.invoke('hosts:snapshot'))[id],
    stack.hostId,
  )
  expect(host?.state).toBe('ready')
  expect(host?.ops).toBe(false)
  expect(host?.lanes.find((l) => l.laneId === stack.laneId)).toMatchObject({
    activity: 'stopped',
    pause,
  })
  const settings = await openAgent(page, stack.origin, stack.hostId)
  await expect(
    settings.getByText('Configuration access is not enabled', { exact: false }),
  ).toBeVisible()
  await expect(settings.getByRole('heading', { name: 'Pending approvals' })).toHaveCount(0)
  await openMachine(page, stack.origin)
  await expect(
    page.getByText('Other machines are unavailable. Update this Host to use machine reach.'),
  ).toBeVisible()
  await expect(page.getByRole('switch', { name: 'Machine reach' })).toHaveCount(0)
})

for (const updated of [true, false]) {
  test(`Machine reach on ${updated ? 'new' : 'old'} control`, async ({ page, stack }) => {
    if (updated) stack.state.machineReach = true
    await page.goto(stack.origin)
    await page.getByRole('button', { name: 'Sign in with GitHub' }).click()
    await expect(page.getByTestId('home-board')).toBeVisible()
    await openMachine(page, stack.origin)
    const toggle = page.getByRole('switch', { name: 'Machine reach' })
    if (!updated) {
      await expect(
        page.getByText("Other machines are unavailable until Phosphor's service updates."),
      ).toBeVisible()
      await expect(toggle).toHaveCount(0)
      return
    }
    await expect(toggle).toBeChecked()
    await toggle.click()
    await expect.poll(() => stack.state.machineReach).toBe(false)
    await openMachine(page, stack.origin)
    await expect(toggle).toBeVisible()
    await expect(toggle).not.toBeChecked()
    await toggle.click()
    await expect.poll(() => stack.state.machineReach).toBe(true)
  })
}
