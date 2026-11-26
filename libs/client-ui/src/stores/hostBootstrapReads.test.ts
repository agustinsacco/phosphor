// @vitest-environment jsdom
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { HostLaneView } from '@shared/ipc'
import type { LiveSessionInfo } from '@shared/models'
import type { Model, RpcCommand, RpcResponse } from '@shared/rpc'

const { installMockPhosphor } = await import('@/dev/mockPhosphor')
installMockPhosphor()
const { useChatStore } = await import('./chat')
const { bootstrapSession, forgetRemoteSession, useSessionsStore } = await import('./sessions')
const { useRemoteLanesStore } = await import('./remoteLanes')
const { hostLaneSession, mockRemoteInfo, MOCK_HOST_ID } = await import('@/dev/mockRemoteLanes')

/*
 * A Host takes at most 32 calls at once on a connection, and a bootstrap read
 * costs it five. A reconnect that shows many open lanes running must not
 * spend them all at once, and a read that a refusal left incomplete is read
 * once more.
 */
const OPUS: Model = {
  id: 'claude-opus-5',
  name: 'Claude Opus 5',
  api: 'pi-claude-cli',
  provider: 'pi-claude-cli',
  reasoning: false,
  input: ['text'],
  contextWindow: 200_000,
  maxTokens: 64_000,
  cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
}
const META = {
  model: OPUS,
  thinkingLevel: 'off',
  isStreaming: false,
  isCompacting: false,
  steeringMode: 'all',
  followUpMode: 'all',
  sessionId: 'x',
  autoCompactionEnabled: true,
  messageCount: 0,
  pendingMessageCount: 0,
} as const
const LANES = 9

type Held = { id: string; command: RpcCommand; answer: (reply: Partial<RpcResponse>) => void }
let held: Held[] = []
/** Replies wait for the test while true; otherwise a stopped lane's reads are refused at once. */
let holding = false
const piCommand = vi.spyOn(window.phosphor, 'piCommand')
const sessionsReading = () => new Set(held.map((call) => call.id)).size
const reads = (id: string, type: RpcCommand['type']) =>
  piCommand.mock.calls.filter(([sid, command]) => sid === id && command.type === type).length

function reply(call: Held, refused = false): void {
  const { command } = call
  if (refused) call.answer({ success: false, error: 'Connection unavailable.' })
  else if (command.type === 'get_state') call.answer({ success: true, data: META })
  else if (command.type === 'get_available_models')
    call.answer({ success: true, data: { models: [OPUS] } })
  else call.answer({ success: false, error: 'Unsupported.' })
}
async function settle(): Promise<void> {
  for (let i = 0; i < 20; i++) await Promise.resolve()
}
/** Answers every held call, round after round, and returns the most lanes read at once. */
async function drain(): Promise<number> {
  let most = sessionsReading()
  while (held.length) {
    const round = held
    held = []
    for (const call of round) reply(call)
    await settle()
    most = Math.max(most, sessionsReading())
  }
  return most
}

const lanes = Array.from({ length: LANES }, (_, i) => ({
  laneId: `lane-${i}`,
  sessionId: `remote-${i}`,
}))
function setActivity(activity: HostLaneView['activity']): void {
  const hosts = structuredClone(useRemoteLanesStore.getState().hosts)
  const host = hosts[MOCK_HOST_ID]!
  host.lanes = host.lanes.map((lane) => ({ ...lane, activity }))
  useRemoteLanesStore.setState({ hosts })
}

beforeEach(async () => {
  held = []
  holding = false
  piCommand.mockReset()
  piCommand.mockImplementation((id, command) => {
    return new Promise((resolve) => {
      const answer = (r: Partial<RpcResponse>) =>
        resolve({ type: 'response', command: command.type, ...r } as never)
      if (command.type === 'get_messages') answer({ success: true, data: { messages: [] } })
      else if (holding) held.push({ id, command, answer })
      else answer({ success: false, error: 'Lane is stopped.' })
    })
  })
  const { hosts } = hostLaneSession({ activity: 'stopped', self: true })
  const host = hosts[MOCK_HOST_ID]!
  const template = host.lanes[0]!
  host.lanes = lanes.map(({ laneId }) => ({ ...template, laneId }))
  useRemoteLanesStore.setState({ hosts })
  useSessionsStore.setState({ live: {} })
  useChatStore.setState({ sessions: {} })
  for (const { laneId, sessionId } of lanes) {
    const info: LiveSessionInfo = { ...mockRemoteInfo, sessionId, laneId }
    await useSessionsStore.getState().adoptSession(sessionId, info.workspacePath, undefined, info)
  }
})
afterEach(async () => {
  holding = false
  for (const call of held) reply(call, true)
  held = []
  for (const { sessionId } of lanes) await forgetRemoteSession(sessionId)
})

it('reads at most three of a Host’s lanes at once when they all start together', async () => {
  holding = true
  setActivity('idle')
  await settle()
  expect(sessionsReading()).toBeGreaterThan(0)
  expect(sessionsReading()).toBeLessThanOrEqual(3)
  expect(await drain()).toBeLessThanOrEqual(3)
  for (const { sessionId } of lanes) {
    expect(useChatStore.getState().sessions[sessionId]?.meta?.model?.id).toBe(OPUS.id)
    expect(reads(sessionId, 'get_state')).toBe(2)
  }
})

it('never queues This Mac’s in-app sessions behind a Host’s reads', async () => {
  holding = true
  setActivity('idle')
  await settle()
  useSessionsStore.setState((s) => ({
    live: { ...s.live, mac: { phosphorId: 'mac', workspacePath: '/mac' } },
  }))
  useChatStore.getState().ensure('mac')
  const mac = bootstrapSession('mac')
  await settle()
  expect(held.some((call) => call.id === 'mac' && call.command.type === 'get_state')).toBe(true)
  await drain()
  await mac
})

it('reads once more after a read it joined was refused, never twice', async () => {
  const { sessionId } = lanes[0]!
  const before = reads(sessionId, 'get_state')
  holding = true
  setActivity('idle')
  await settle()
  // A stream reset's bootstraps join the start's read in flight, which the Host refuses.
  const joiners = [bootstrapSession(sessionId), bootstrapSession(sessionId)]
  const refused = held.filter((call) => call.id === sessionId)
  held = held.filter((call) => call.id !== sessionId)
  for (const call of refused) reply(call, true)
  await settle()
  await drain()
  await Promise.all(joiners)
  expect(reads(sessionId, 'get_state') - before).toBe(2)
  expect(useChatStore.getState().sessions[sessionId]?.meta?.model?.id).toBe(OPUS.id)
})
