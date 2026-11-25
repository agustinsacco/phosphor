import type { ClientFrame } from '@phosphor/shared/host-protocol'
import { test, expect } from './fixture'

test('a stopped lane keeps its title and unavailable history when Resume fails', async ({
  page,
  stack,
}) => {
  await page.setViewportSize({ width: 1440, height: 900 })
  await page.routeWebSocket('**/fixture-host', (route) => {
    const server = route.connectToServer()
    route.onMessage((raw) => {
      const frame = JSON.parse(raw.toString()) as ClientFrame
      if (frame.type === 'subscribe' && frame.topic === 'lane' && frame.laneId === stack.laneId)
        route.send(JSON.stringify({ type: 'subscribe-failed', id: frame.id, code: 'too-large' }))
      else if (frame.type === 'command' && frame.op.type === 'lane.resume')
        route.send(
          JSON.stringify({
            type: 'receipt',
            receipt: {
              requestId: frame.requestId,
              status: 'failed',
              error: { code: 'internal', message: 'the lane could not start' },
            },
          }),
        )
      else server.send(raw)
    })
  })
  await page.goto(stack.origin)
  await page.getByRole('button', { name: 'Sign in with GitHub' }).click()
  await expect(page.getByText('Synthetic acceptance lane', { exact: true }).first()).toBeVisible()
  await page.evaluate(
    async ([host, lane]) => {
      await window.phosphor.invoke('hosts:takeControl', host, lane)
      await window.phosphor.invoke('hosts:stopLane', host, lane)
    },
    [stack.hostId, stack.laneId] as const,
  )
  await page.goto(`${stack.origin}/lanes/${stack.hostId}/${stack.laneId}/chat`)
  await expect(
    page.getByText('This conversation is too large to preview.', { exact: true }),
  ).toBeVisible()
  await expect(page.getByText('Describe a task to begin')).toHaveCount(0)
  await expect(
    page.locator('header').getByText('Synthetic acceptance lane', { exact: true }),
  ).toBeVisible()
  await page.getByRole('button', { name: 'Resume', exact: true }).click()
  await expect(
    page.getByRole('alert').filter({ hasText: "Couldn't start this lane." }),
  ).toBeVisible()
})
