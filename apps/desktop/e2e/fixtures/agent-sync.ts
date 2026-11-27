import { expect, type Page } from '@playwright/test'

export const issuerTitle = 'Agent op issuer'
export const originalTitle = 'Created by the agent'
export const changedTitle = 'Renamed by the agent'
export const addedFolder = 'agent-added-folder'
export const addedRoutine = 'Agent-created routine'

export async function startIssuer(page: Page, hostId: string) {
  return page.evaluate(
    async ({ hostId, issuerTitle }) => {
      const { repositories } = (await window.phosphor.invoke('hosts:snapshot'))[hostId]!
      const repositoryId = repositories[0]!.id
      const { sessionId } = await window.phosphor.invoke('hosts:createLane', hostId, {
        repositoryId,
        name: issuerTitle,
        provider: 'stub',
        model: 'stub-model',
      })
      return { sessionId, repositoryId }
    },
    { hostId, issuerTitle },
  )
}

export async function sendOp(page: Page, sessionId: string, args: string[]) {
  const result = await page.evaluate(
    ({ sessionId, args }) =>
      window.phosphor.piCommand(sessionId, {
        type: 'prompt',
        message: `Test op: ${JSON.stringify({ args, reason: 'Exercise live Host projection' })}`,
      }),
    { sessionId, args },
  )
  expect(result.success).toBe(true)
}

export function routineArgs(repositoryId: string) {
  return [
    'routine.create',
    '--definition',
    JSON.stringify({
      name: addedRoutine,
      instructions: 'Summarize the synthetic test',
      repositoryId,
      isolated: false,
      intent: 'report',
      provider: 'stub',
      model: 'stub-model',
      timezone: 'UTC',
      schedule: { kind: 'manual' },
      period: 'none',
      catchUpHours: 0,
      maxRuntimeMinutes: 10,
    }),
  ]
}

export async function findCreated(page: Page, hostId: string) {
  const read = () =>
    page.evaluate(
      async ({ hostId, title }) =>
        (await window.phosphor.invoke('hosts:snapshot'))[hostId]?.lanes.find(
          (lane) => lane.title === title,
        ),
      { hostId, title: originalTitle },
    )
  await expect.poll(read).toBeDefined()
  return (await read())!.laneId
}

export async function openControlled(page: Page, hostId: string, laneId: string) {
  return page.evaluate(
    async ({ hostId, laneId }) => {
      const { sessionId } = await window.phosphor.invoke('hosts:openLane', hostId, laneId)
      await window.phosphor.invoke('hosts:takeControl', hostId, laneId)
      return sessionId
    },
    { hostId, laneId },
  )
}
