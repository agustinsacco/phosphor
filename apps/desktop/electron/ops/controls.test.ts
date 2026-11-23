import { beforeEach, expect, it, vi } from 'vitest'
import type { OpHandlerContext } from '@phosphor/session-runtime/ops/types'
import { controlHandlers, markHandlers } from './controls'

const h = vi.hoisted(() => ({
  markers: {} as Record<string, string>,
  broadcast: vi.fn(),
}))
vi.mock('../broadcast', () => ({ broadcast: h.broadcast }))
vi.mock('../store', () => ({
  getPrefs: () => ({ laneMarkers: h.markers }),
  setLaneMarkers: (markers: Record<string, string>) => {
    h.markers = markers
  },
}))

const lane = {
  ref: 'local/session:disk-id',
  sessionId: 'mine',
  title: 'My lane',
  cwd: '/work',
  busy: false,
  controller: null,
  path: '/work/mine.jsonl',
}
const agent = { kind: 'agent', laneRef: lane.ref, sessionId: 'mine', unattended: false, lineage: 0 }
const surface = { kind: 'surface', clientId: 'ui', label: 'Phosphor', via: 'owner' }
const ctx = (principal: object, extra: Partial<OpHandlerContext> = {}) =>
  ({ principal, reason: 'tidy', lane, log: () => {}, ...extra }) as unknown as OpHandlerContext

beforeEach(() => {
  h.markers = {}
})

it('answers the asking lane’s own controls as effects for its tool', async () => {
  expect(await controlHandlers['swarm.on']({}, ctx(agent))).toEqual({
    text: 'Swarm on.',
    effects: [{ kind: 'swarm', enabled: true, reason: 'tidy' }],
  })
  expect(await controlHandlers['pr.hide']({ url: 'https://x/1' }, ctx(agent))).toEqual({
    text: 'PR hide: https://x/1',
    effects: [{ kind: 'pr', action: 'hide', url: 'https://x/1' }],
  })
  expect(
    await controlHandlers['contextFiles.set']({ claude: false, agents: true }, ctx(agent)),
  ).toEqual({
    text: 'claude=off agents=on',
    effects: [{ kind: 'contextFiles', args: 'claude=off agents=on' }],
  })
  expect(await controlHandlers.notify({ text: 'done' }, ctx(agent))).toEqual({
    text: 'Notified.',
    effects: [{ kind: 'notify', message: 'Agent: done', level: 'info' }],
  })
})

it('refuses a lane effect from anyone but the lane itself', async () => {
  await expect(controlHandlers['swarm.off']({}, ctx(surface))).rejects.toMatchObject({
    code: 'bad-request',
    message: 'Run this operation inside the lane.',
  })
})

it('defers model, thinking, compaction, retry and queue changes until the run ends', async () => {
  expect(await controlHandlers['model.set']({ model: 'openai/gpt-5' }, ctx(agent))).toEqual({
    text: 'Queued model for after this run.',
    deferred: [{ kind: 'model', provider: 'openai', modelId: 'gpt-5' }],
  })
  await expect(controlHandlers['model.set']({ model: 'gpt-5' }, ctx(agent))).rejects.toMatchObject({
    code: 'bad-request',
    message: 'Use provider/model.',
  })
  expect(await controlHandlers['thinking.set']({ level: 'high' }, ctx(agent))).toMatchObject({
    deferred: [{ kind: 'thinking', level: 'high' }],
  })
  expect(await controlHandlers['lane.compact']({}, ctx(agent))).toMatchObject({
    deferred: [{ kind: 'compact', instructions: undefined }],
  })
  expect(await controlHandlers['lane.autoRetry']({ on: false }, ctx(agent))).toMatchObject({
    deferred: [{ kind: 'autoRetry', enabled: false }],
  })
  expect(
    await controlHandlers['lane.queueMode']({ queue: 'steering', mode: 'all' }, ctx(agent)),
  ).toMatchObject({ deferred: [{ kind: 'steering', mode: 'all' }] })
  await expect(
    controlHandlers['lane.autoCompaction'](
      { on: true },
      ctx(agent, { lane: { ...lane, sessionId: null } }),
    ),
  ).rejects.toMatchObject({ code: 'unavailable', message: 'This lane is not running.' })
})

it('stores the marker exactly as given, none included, and returns the previous one', async () => {
  expect(await markHandlers['lane.marker']({ marker: 'none' }, ctx(agent))).toEqual({
    text: 'Updated lane marker.',
    before: undefined,
  })
  expect(h.markers).toEqual({ [lane.path]: 'none' })
  expect(await markHandlers['lane.marker']({ marker: '🔥' }, ctx(agent))).toEqual({
    text: 'Updated lane marker.',
    before: { ref: lane.ref, marker: 'none' },
  })
  expect(h.markers).toEqual({ [lane.path]: '🔥' })
})
