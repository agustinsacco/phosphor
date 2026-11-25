import type { HostFrame } from '@phosphor/shared/host-protocol'
import { test, expect } from './fixture'

// Keep the real grant, fences and lifecycle commands; vary only the Host's machine policy.
test('opening an unheld stopped service lane starts pi before the first prompt', async ({
  stack,
  page,
}) => {
  await page.routeWebSocket('**/fixture-host', (route) => {
    const server = route.connectToServer()
    server.onMessage((raw) => {
      const frame = JSON.parse(raw.toString()) as HostFrame
      route.send(frame.type === 'ready' ? JSON.stringify({ ...frame, warmOnOpen: true }) : raw)
    })
  })
  await page.goto(stack.origin)
  await page.getByRole('button', { name: 'Sign in with GitHub' }).click()
  await expect(
    page
      .getByTestId('home-board')
      .getByRole('button', { name: 'Synthetic acceptance lane', exact: true }),
  ).toBeVisible()
  await page.evaluate(
    async ([host, lane]) => {
      await window.phosphor.invoke('hosts:takeControl', host, lane)
      await window.phosphor.invoke('hosts:stopLane', host, lane)
      await window.phosphor.invoke('hosts:releaseControl', host, lane)
    },
    [stack.hostId, stack.laneId] as const,
  )
  const state = () =>
    page.evaluate(
      async ([host, lane]) =>
        (await window.phosphor.invoke('hosts:snapshot'))[host]?.lanes.find(
          (l) => l.laneId === lane,
        ),
      [stack.hostId, stack.laneId] as const,
    )
  await expect.poll(state).toMatchObject({ activity: 'stopped', control: { controller: null } })
  await page.goto(`${stack.origin}/lanes/${stack.hostId}/${stack.laneId}/chat`)
  await expect
    .poll(state)
    .toMatchObject({ activity: 'idle', control: { controller: { self: true } } })
})
