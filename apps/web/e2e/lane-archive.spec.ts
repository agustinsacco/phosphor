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
  const row = page.getByTestId('archive-row').filter({ hasText: TITLE })
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

test('the Archive page cleans up a whole selection in one confirmation', async ({
  page,
  stack,
}) => {
  await openLane(page, stack.origin)
  await takeControl(page)
  // Archiving is a controlling action per lane, so hold both before either goes.
  expect(await call(page, 'hosts:takeControl', stack.hostId, stack.secondLaneId)).toEqual({
    value: null,
  })
  for (const laneId of [stack.laneId, stack.secondLaneId]) {
    expect(await call(page, 'hosts:archiveLane', stack.hostId, laneId)).toEqual({ value: null })
  }
  const archivedCount = () => archives(page, stack.hostId).then((list) => list.length)
  await expect.poll(archivedCount).toBe(2)

  await page.goto(`${stack.origin}/pages/archive`)
  await page.getByRole('button', { name: 'Select all', exact: true }).click()
  const bar = page.getByTestId('bulk-bar')
  await expect(bar).toContainText('2 selected')
  await bar.getByRole('button', { name: 'Clean up…', exact: true }).click()

  const confirm = page.getByRole('button', { name: 'Clean up 2 archived lanes', exact: true })
  await expect(confirm).toBeDisabled()
  await page.getByText('I understand this is permanent.').click()
  await expect(confirm).toBeEnabled()
  await confirm.click()

  await expect.poll(archivedCount).toBe(0)
  expect(await laneIds(page, stack.hostId)).toEqual([])
})

test('a browser reader is refused lane archiving by the Host', async ({ page, stack }) => {
  await openLane(page, stack.origin)
  expect((await call(page, 'hosts:archiveLane', stack.hostId, stack.laneId)).error).toBeTruthy()
  expect(await laneIds(page, stack.hostId)).toContain(stack.laneId)
  expect(await archives(page, stack.hostId)).toEqual([])
  await expect(page.getByText('No controller', { exact: true })).toBeVisible()
})
