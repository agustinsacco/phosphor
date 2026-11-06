import { EventEmitter } from 'node:events'
import { afterEach, expect, it, vi } from 'vitest'
import type { LiveSession } from '@phosphor/session-runtime/pi/session-registry'
import type { PiRpcClient } from '@phosphor/session-runtime/pi/rpc-client'
import { attachBrainCapture, newUserCaptures } from './capture'
import { adapterFixture } from './__fixtures__/adapter-fixture'

const cleanup: (() => Promise<void>)[] = []
afterEach(async () => { for (const close of cleanup.splice(0).reverse()) await close() })
const authority = { scope: '/repo', branch: 'main' }
const entry = (id: string, role = 'user', parentId: string | null = 'old') => ({ type: 'message', id, parentId, timestamp: new Date().toISOString(), message: { role, content: [{ type: 'text', text: 'plain new input' }] } })
it('captures new plain user entries only, preserving original ids/root lineage across forks', () => {
  const entries = [entry('old', 'user', null), entry('new'), entry('assistant', 'assistant', 'new'), entry('tool', 'toolResult', 'assistant'), { ...entry('shell', 'bashExecution', 'tool') }, { ...entry('generated', 'custom', 'shell') }]
  const first = newUserCaptures(entries, new Set(['old']), authority, 'native-1')
  const fork = newUserCaptures(entries, new Set(['old']), authority, 'native-2')
  expect(first).toHaveLength(1)
  expect(first[0]).toMatchObject({ entryId: 'new', rootIds: ['new'], parentId: 'old', role: 'user' })
  expect(fork[0]!.rootIds).toEqual(first[0]!.rootIds)
  expect(newUserCaptures(entries, new Set(entries.map((item) => item.id)), authority, 'native-1')).toEqual([])
})
it('omits ambiguous parents, generated/source-tagged inputs and non-plain content', () => {
  const entries = [entry('orphan', 'user', 'missing'), { ...entry('tagged'), message: { role: 'user', content: 'generated', source: 'extension' } }, { ...entry('image'), message: { role: 'user', content: [{ type: 'image' }] } }]
  expect(newUserCaptures(entries, new Set(['old']), authority, 'native')).toEqual([])
  expect(() => newUserCaptures([{ type: 'message' }], new Set(), authority, 'native')).toThrow('identity')
})
it('baselines historical entries and does not reinterpret them when policy changes', async () => {
  const f = await adapterFixture(); cleanup.push(f.cleanup)
  let entries = [entry('old', 'user', null)]
  const client = Object.assign(new EventEmitter(), { request: vi.fn(async (command: { type: string }) => command.type === 'get_state' ? { success: true, data: { sessionId: 'native-new' } } : { success: true, data: { entries } }) })
  const live: LiveSession = { sessionId: 'runtime', workspacePath: f.scope, client: client as unknown as PiRpcClient }
  const detach = await attachBrainCapture(live, f.store, f.snapshot.policyEpoch, (error) => { throw error }); cleanup.push(async () => detach())
  entries = [...entries, entry('new')]
  client.emit('event', { type: 'agent_end' })
  await vi.waitFor(() => expect(f.engine.snapshot().counts.evidence).toBe(2))
  f.engine.setPrefs({ ...f.snapshot.prefs, recall: false })
  entries = [...entries, entry('after-policy', 'user', 'new')]
  client.emit('event', { type: 'agent_end' })
  await new Promise((resolve) => setTimeout(resolve, 25))
  expect(f.engine.snapshot().counts.evidence).toBe(2)
})
it('stops capture when the native transcript identity changes instead of importing switched history', async () => {
  const f = await adapterFixture(); cleanup.push(f.cleanup)
  let nativeId = 'native-initial'
  let entries = [entry('old', 'user', null)]
  const client = Object.assign(new EventEmitter(), { request: vi.fn(async (command: { type: string }) => command.type === 'get_state' ? { success: true, data: { sessionId: nativeId } } : { success: true, data: { entries } }) })
  const live: LiveSession = { sessionId: 'runtime', workspacePath: f.scope, client: client as unknown as PiRpcClient }
  const detach = await attachBrainCapture(live, f.store, f.snapshot.policyEpoch, (error) => { throw error }); cleanup.push(async () => detach())
  nativeId = 'old-different-transcript'
  entries = [entry('historical', 'user', null)]
  client.emit('event', { type: 'agent_end' })
  await new Promise((resolve) => setTimeout(resolve, 40))
  expect(f.engine.snapshot().counts.evidence).toBe(1)
})
