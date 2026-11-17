import type { Page } from '@playwright/test'
import type { LaneArchiveEntry } from '@phosphor/shared/lane-archive'
import { test, expect } from './fixture'

const TITLE = 'Synthetic acceptance lane'

async function openLane(page: Page, origin: string) {
  await page.goto(origin)
  await page.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click()
  await expect(page.getByTestId('compact-shell')).toBeVisible()
  await page.getByRole('button', { name: TITLE, exact: true }).click()
  await expect(page.getByText('No controller', { exact: true })).toBeVisible()
}
async function takeControl(page: Page) {
  await page.getByRole('button', { name: 'Take control', exact: true }).click()
  await expect(page.getByText('Controlled by you', { exact: true })).toBeVisible()
}
/** The browser adapter's real IPC, as the shared lane actions and Archive page call it. */
function call(page: Page, channel: string, ...args: unknown[]) {
  return page.evaluate(
    async ([name, rest]) => {
      const invoke = window.phosphor.invoke as unknown as (
        c: string,
        ...a: unknown[]
      ) => Promise<unknown>
      try {
        return { value: (await invoke(name, ...rest)) ?? null }
      } catch (error) {
        return { error: error instanceof Error ? error.message : String(error) }
      }
    },
    [channel, args] as [string, unknown[]],
  )
}
function laneIds(page: Page, hostId: string) {
  return page.evaluate(
    async (host) =>
      (await window.phosphor.invoke('hosts:snapshot'))[host]?.lanes.map((l) => l.laneId) ?? [],
    hostId,
  )
}
async function archives(page: Page, hostId: string): Promise<LaneArchiveEntry[]> {
  const result = await call(page, 'hosts:archives', hostId)
  expect(result.error).toBeUndefined()
  return (result.value as { entries: LaneArchiveEntry[] }).entries
}

test('a controlling browser archives a lane, and the Archive page restores it', async ({
  page,
  stack,
}) => {
  await openLane(page, stack.origin)
  await takeControl(page)
  expect(await call(page, 'hosts:archiveLane', stack.hostId, stack.laneId)).toEqual({
    value: null,
  })
  await expect.poll(() => laneIds(page, stack.hostId)).not.toContain(stack.laneId)
  expect(await laneIds(page, stack.hostId)).toContain(stack.secondLaneId)
  expect(await archives(page, stack.hostId)).toMatchObject([{ title: TITLE, state: 'archived' }])

  await page.goto(`${stack.origin}/pages/archive`)
  const row = page.getByRole('heading', { name: TITLE, exact: true }).locator('..').locator('..')
  await row.getByRole('button', { name: 'Restore', exact: true }).click()
  await expect.poll(() => laneIds(page, stack.hostId)).toContain(stack.laneId)
  await expect(page.getByText('No archived lanes.')).toBeVisible()
  expect(await archives(page, stack.hostId)).toEqual([])
})

test('cleaning up an archive keeps the project and cannot be restored', async ({ page, stack }) => {
  await openLane(page, stack.origin)
  await takeControl(page)
  expect(await call(page, 'hosts:archiveLane', stack.hostId, stack.laneId)).toEqual({
    value: null,
  })
  const [entry] = await archives(page, stack.hostId)
  expect(entry?.worktree).not.toBe(true)
  expect(await call(page, 'hosts:purgeArchive', stack.hostId, entry!.id, false)).toEqual({
    value: null,
  })
  expect(await archives(page, stack.hostId)).toEqual([])
  expect((await call(page, 'hosts:restoreArchive', stack.hostId, entry!.id)).error).toBeTruthy()
  expect(await laneIds(page, stack.hostId)).not.toContain(stack.laneId)
  expect(await laneIds(page, stack.hostId)).toContain(stack.secondLaneId)
})

test('a browser reader is refused lane archiving by the Host', async ({ page, stack }) => {
  await openLane(page, stack.origin)
  expect((await call(page, 'hosts:archiveLane', stack.hostId, stack.laneId)).error).toBeTruthy()
  expect(await laneIds(page, stack.hostId)).toContain(stack.laneId)
  expect(await archives(page, stack.hostId)).toEqual([])
  await expect(page.getByText('No controller', { exact: true })).toBeVisible()
})
