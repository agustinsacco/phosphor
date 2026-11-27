import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { createReservedLane } from '@phosphor/session-runtime/pi/reserved-lane'
import type { AppServices } from '../app-services'
import type { OpsService } from '../../ops/service'
import { createBrainContribution } from './brain'
import { createOpsContribution } from './ops'

const lane = createReservedLane('brain-agent', '/state/brain/Brain')
const reserved = { reserved: lane }
const policy = { options: { workspacePath: lane.folder } } as never

it('gives the reserved lane neither recall nor its recall registration', async () => {
  const attachLane = vi.fn(() => () => {})
  const appServices = {
    resources: vi.fn(async () => ({ extensions: ['/brain.mjs'], skills: ['/skills/brain'] })),
    attachLane,
  } as unknown as AppServices
  const recall = createBrainContribution({ appServices, resourceRoot: '/bundle' })
  expect(await recall.spawn(reserved, policy)).toBeUndefined()
  recall.attach?.(
    {
      sessionId: 's',
      workspacePath: lane.folder,
      client: new EventEmitter(),
      reserved: lane,
    } as never,
    {
      execution: reserved,
    } as never,
  )
  expect(attachLane).not.toHaveBeenCalled()
  // An ordinary lane in the same folder still gets recall.
  expect(await recall.spawn({}, policy)).toEqual({
    extensions: ['/brain.mjs'],
    skills: ['/skills/brain'],
  })
})

it('gives the reserved lane no agent-control channel or tool', async () => {
  const ops = createOpsContribution({
    service: () => ({ agentControl: async () => true }) as unknown as OpsService,
    resourceRoot: () => '/bundle',
    unattended: new Set(),
  })!
  expect(await ops.spawn(reserved, policy)).toBeUndefined()
  const client = new EventEmitter()
  ops.attach?.(
    { sessionId: 's', client, reserved: lane } as never,
    {
      execution: reserved,
      log: vi.fn(),
      options: {},
    } as never,
  )
  expect(client.listenerCount('event')).toBe(0)
})
