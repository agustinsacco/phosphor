import type { Page } from '@playwright/test'
import { test, expect } from './fixture'

async function openLane(page: Page, origin: string) {
  await page.goto(origin)
  await page.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click()
  await expect(page.getByTestId('compact-shell')).toBeVisible()
  await page.getByRole('button', { name: 'Synthetic acceptance lane', exact: true }).click()
  await expect(page.getByText('No controller', { exact: true })).toBeVisible()
}
/** The browser adapter's real `hosts:deleteLane`, as the shared lane actions call it. */
function deleteLane(page: Page, hostId: string, laneId: string) {
  return page.evaluate(
    async ([host, lane]) => {
      try {
        return await window.phosphor.invoke('hosts:deleteLane', host!, lane!, {
          removeWorktree: false,
          removeBranch: false,
        })
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
    [hostId, laneId],
  )
}
function laneIds(page: Page, hostId: string) {
  return page.evaluate(
    async (host) =>
      (await window.phosphor.invoke('hosts:snapshot'))[host]?.lanes.map((l) => l.laneId) ?? [],
    hostId,
  )
}

test('a browser that takes control of a lane deletes it on the Host', async ({ page, stack }) => {
  await openLane(page, stack.origin)
  await page.getByRole('button', { name: 'Take control', exact: true }).click()
  await expect(page.getByText('Controlled by you', { exact: true })).toBeVisible()
  expect(await deleteLane(page, stack.hostId, stack.laneId)).toEqual({ branchKept: false })
  await expect.poll(() => laneIds(page, stack.hostId)).not.toContain(stack.laneId)
  expect(await laneIds(page, stack.hostId)).toContain(stack.secondLaneId)
})

test('a browser reader is refused lane deletion by the Host', async ({ page, stack }) => {
  await openLane(page, stack.origin)
  expect(await deleteLane(page, stack.hostId, stack.laneId)).toEqual({
    error: 'The remote change was not confirmed.',
  })
  expect(await laneIds(page, stack.hostId)).toContain(stack.laneId)
  await expect(page.getByText('No controller', { exact: true })).toBeVisible()
})
