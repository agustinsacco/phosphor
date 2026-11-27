import {
  addedFolder,
  addedRoutine,
  changedTitle,
  findCreated,
  openControlled,
  originalTitle,
  routineArgs,
  sendOp,
  startIssuer,
} from '../../desktop/e2e/fixtures/agent-sync'
import { expect, test } from './fixture'

test.use({ agentOps: true })

test('PWA projects an agent-created lane and live mutations from a Host', async ({
  page,
  context,
  stack,
}) => {
  const { origin, hostId } = stack
  await page.goto(origin)
  await page.getByRole('button', { name: 'Sign in with GitHub', exact: true }).click()
  const board = page.getByTestId('home-board')
  await expect(
    board.getByRole('button', { name: 'Synthetic acceptance lane', exact: true }),
  ).toBeVisible()
  const { sessionId, repositoryId } = await startIssuer(page, hostId)
  const op = (args: string[]) => sendOp(page, sessionId, args)
  await op(['lane.create', '--folder', repositoryId, '--name', originalTitle])
  const laneId = await findCreated(page, hostId)
  await expect(board.getByRole('button', { name: originalTitle, exact: true })).toBeVisible()
  await op(['lane.rename', '--ref', laneId, changedTitle])
  const row = board.getByRole('button', { name: changedTitle, exact: true })
  await expect(row).toBeVisible()
  const projected = () =>
    page.evaluate(
      async ({ hostId, laneId }) =>
        (await window.phosphor.invoke('hosts:snapshot'))[hostId]?.lanes.find(
          (lane) => lane.laneId === laneId,
        ),
      { hostId, laneId },
    )
  await op(['lane.pin', '--ref', laneId, 'on'])
  await expect.poll(projected).toMatchObject({ pinned: true })
  await op(['lane.marker', '--ref', laneId, '🚀'])
  await expect.poll(projected).toMatchObject({ marker: '🚀' })

  const observer = await context.newPage()
  await observer.goto(`${origin}/pages/archive`)
  await expect(observer.getByText('No archived lanes.')).toBeVisible()
  const created = await openControlled(page, hostId, laneId)
  await sendOp(page, created, ['lane.archive', laneId])
  await expect(row).toHaveCount(0)
  const archive = observer.getByTestId('archive-row').filter({ hasText: changedTitle })
  await expect(archive).toBeVisible()
  await op(['archive.restore', laneId])
  await expect(archive).toHaveCount(0)
  await expect(row).toBeVisible()
  await observer.goto(`${origin}/pages/settings/${hostId}`)
  await observer.getByRole('button', { name: 'Folders', exact: true }).click()
  await op(['folder.add', addedFolder])
  await expect(observer.getByText(addedFolder, { exact: true }).first()).toBeVisible()
  await observer.goto(`${origin}/pages/routines/${hostId}`)
  await expect(observer.getByTestId('global-page')).toBeVisible()
  await op(routineArgs(repositoryId))
  await expect(observer.getByTestId('global-page')).toContainText(addedRoutine)
})
