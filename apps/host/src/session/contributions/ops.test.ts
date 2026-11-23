import { EventEmitter } from 'node:events'
import { expect, it, vi } from 'vitest'
import { OP_MARKER_ENV, OP_MARKER_VALUE } from '@phosphor/shared/ops'
import type { OpsService } from '../../ops/service'
import { createOpsContribution, type HostOpsLanePorts } from './ops'

function lane(unattended: boolean) {
  const client = new EventEmitter()
  const session = { sessionId: 'session-1', client } as never
  const ctx = { execution: { unattended }, log: vi.fn(), options: {} } as never
  return { client, session, ctx }
}

function ports(service: Partial<OpsService> | null): HostOpsLanePorts {
  return {
    service: () => service as OpsService | null,
    resourceRoot: () => '/bundle',
    unattended: new Set(),
  }
}

it('is absent without ports, so a runtime built without agent control spawns as before', () => {
  expect(createOpsContribution()).toBeNull()
})

it('adds the tool and skill only while agent control is on, and the marker always', async () => {
  const on = createOpsContribution(ports({ agentControl: async () => true }))!
  expect(await on.spawn?.({} as never, {} as never)).toEqual({
    env: { [OP_MARKER_ENV]: OP_MARKER_VALUE },
    extensions: ['/bundle/pi-ext/phosphor.ts'],
    skills: ['/bundle/skills/phosphor'],
  })
  const unbound = createOpsContribution(ports(null))!
  expect(await unbound.spawn?.({} as never, {} as never)).toEqual({
    env: { [OP_MARKER_ENV]: OP_MARKER_VALUE },
  })
})

it('binds op dialogs, applies deferred work when a run settles and tracks unattended runs', async () => {
  const confirmSeen = vi.fn()
  const settled = vi.fn(async () => {})
  const lanePorts = ports({
    dispatcher: { confirmSeen, settled, runFromTool: vi.fn(), cancelLane: vi.fn() } as never,
  })
  const { client, session, ctx } = lane(true)
  createOpsContribution(lanePorts)!.attach?.(session, ctx)
  expect(lanePorts.unattended.has('session-1')).toBe(true)
  const dialog = { method: 'confirm', id: 'd1', title: 'Phosphor: x', message: 'y' }
  client.emit('extension-ui', dialog)
  client.emit('extension-ui', { method: 'select', id: 'd2', title: 't', options: [] })
  expect(confirmSeen).toHaveBeenCalledExactlyOnceWith('session-1', dialog)
  client.emit('event', { type: 'agent_settled' })
  expect(settled).toHaveBeenCalledWith('session-1', {})
  client.emit('exit')
  expect(lanePorts.unattended.has('session-1')).toBe(false)
})
