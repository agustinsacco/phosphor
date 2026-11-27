import { EventEmitter } from 'node:events'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import type { LiveSession } from '@phosphor/session-runtime/pi/session-registry'
import type { OpHandlerContext } from '@phosphor/session-runtime/ops/types'
import { createBrainHandlers } from '../ops/handlers/brain'
import { createAppServices } from '../session/app-services'
import { createBrainContribution } from '../session/contributions/brain'

const uid = process.getuid!()
const dirs: string[] = []
afterEach(() => dirs.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })))
function legacy() {
  const state = mkdtempSync(join(tmpdir(), 'hb-'))
  dirs.push(state)
  return createAppServices(state, uid)
}

const context: OpHandlerContext = {
  principal: { kind: 'agent', laneRef: 'ref', sessionId: 'session', unattended: false, lineage: 0 },
  signal: new AbortController().signal,
  lane: {
    ref: 'ref',
    sessionId: 'session',
    title: 'Harbor',
    cwd: '/repo',
    busy: false,
    controller: null,
  },
  log: vi.fn(),
}

function native(active: boolean) {
  const port = {
    search: vi.fn(async () => ({
      text: 'Harbor ships Fridays.',
      data: { status: 'ok', memories: 1 },
    })),
    flag: vi.fn(async () => ({ text: 'Filed.', data: { status: 'filed' } })),
  }
  return {
    port,
    recall: {
      active: () => active,
      resources: vi.fn(async () => ({
        extensions: ['/res/brain-ext/brain.mjs'],
        skills: ['/res/skills/brain'],
      })),
      attachLane: vi.fn(() => () => {}),
      forLane: vi.fn(async () => port),
    },
  }
}

it('answers an ordinary lane from the Host Brain, not a Desktop registration, while it is active', async () => {
  const { port, recall } = native(true)
  const handlers = createBrainHandlers(legacy(), recall)
  expect(await handlers['brain.search']({ query: 'Harbor' }, context)).toMatchObject({
    data: { status: 'ok', memories: 1 },
  })
  expect(recall.forLane).toHaveBeenCalledWith('session', 'Harbor')
  expect(port.search).toHaveBeenCalledWith({ query: 'Harbor' })
  const contribution = createBrainContribution({
    appServices: legacy(),
    resourceRoot: '/res',
    native: recall,
  })
  expect(await contribution.spawn({}, { options: { workspacePath: '/repo' } } as never)).toEqual({
    extensions: ['/res/brain-ext/brain.mjs'],
    skills: ['/res/skills/brain'],
  })
  const client = Object.assign(new EventEmitter(), { piSessionId: 'harbor-pi' })
  const live = { sessionId: 'session', client, workspacePath: '/repo' } as unknown as LiveSession
  contribution.attach!(live, { execution: {}, options: { workspacePath: '/repo' }, log: vi.fn() })
  expect(recall.attachLane).toHaveBeenCalledWith('session', '/repo', expect.any(Function))
})

it('keeps the Desktop registration path while the Host Brain is off', async () => {
  const { port, recall } = native(false)
  const handlers = createBrainHandlers(legacy(), recall)
  expect(await handlers['brain.search']({ query: 'Harbor' }, context)).toMatchObject({
    data: { status: 'unavailable' },
  })
  expect(port.search).not.toHaveBeenCalled()
  const contribution = createBrainContribution({
    appServices: legacy(),
    resourceRoot: '/res',
    native: recall,
  })
  expect(await contribution.spawn({}, { options: { workspacePath: '/repo' } } as never)).toBe(
    undefined,
  )
  expect(recall.resources).not.toHaveBeenCalled()
})
