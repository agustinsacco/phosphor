import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it } from 'vitest'
import { parseHostFrame, type HostFrame } from '@phosphor/shared/host-protocol'
import { createLoopbackPair } from '@phosphor/shared/host-protocol-testing'
import type { RpcSessionState } from '@phosphor/shared/rpc'
import { createHostLiveLanes } from './live-host'
import { openStore } from './store'
import { createSubscriptions } from './subscriptions'

const oldTurn = { role: 'user', content: 'Before compaction' }
const keptTurn = {
  role: 'assistant',
  content: [],
  provider: 'custom',
  model: 'model',
  usage: { totalTokens: 42_000 },
}
const piState: RpcSessionState = {
  sessionId: 'pi',
  thinkingLevel: 'off',
  isStreaming: false,
  isCompacting: false,
  steeringMode: 'all',
  followUpMode: 'all',
  autoCompactionEnabled: true,
  messageCount: 2,
  pendingMessageCount: 0,
}
const cleanups: Array<() => void> = []
afterEach(() => {
  for (const clean of cleanups.splice(0).reverse()) clean()
})

async function openChat() {
  const dir = mkdtempSync(join(tmpdir(), 'host-stopped-composer-'))
  cleanups.push(() => rmSync(dir, { recursive: true, force: true }))
  const store = await openStore(join(dir, 'state'), process.getuid?.())
  cleanups.push(() => store.close())
  const repo = store.syncRepositories([dir])[0]
  if (!repo) throw new Error('missing repository')
  const sessionFile = join(dir, 'lane.jsonl')
  writeFileSync(
    sessionFile,
    [
      { type: 'session', version: 3, id: 'pi' },
      { type: 'message', id: 'old', parentId: null, message: oldTurn },
      {
        type: 'compaction',
        id: 'compact',
        parentId: 'old',
        firstKeptEntryId: 'kept',
        summary: 'Earlier turns summarized',
        tokensBefore: 100_000,
        timestamp: 0,
      },
      { type: 'message', id: 'kept', parentId: 'compact', message: keptTurn },
    ]
      .map((entry) => JSON.stringify(entry))
      .join('\n'),
  )
  const { laneId } = store.ensureLane({ repositoryId: repo.id, cwd: dir, sessionFile })
  const { live } = createHostLiveLanes({
    epoch: '0123456789abcdef',
    store,
    now: Date.now,
    log: () => {},
    sessionsRoot: dir,
    runtime: {
      command: async (_id, command) => ({
        type: 'response',
        success: true,
        command: command.type,
        data: command.type === 'get_messages' ? { messages: [oldTurn, keptTurn] } : piState,
      }),
    },
  })
  cleanups.push(live.close)
  await live.attach(laneId, 'pi').ready
  const frames: HostFrame[] = []
  const pair = createLoopbackPair()
  pair.client.onMessage((data) => {
    const parsed = parseHostFrame(data)
    if (!parsed.ok) throw new Error('invalid Host frame')
    frames.push(parsed.value)
  })
  const subscriptions = createSubscriptions(pair.server, live.streams, live.lanesTopic)
  cleanups.push(subscriptions.close)
  const subscribe = (id: string, after?: ReturnType<typeof live.streams.cursor>) =>
    subscriptions.handle({ type: 'subscribe', topic: 'lane', id, laneId, after })
  subscribe('open')
  await Promise.resolve()
  expect(frames.shift()).toMatchObject({
    type: 'snapshot',
    snapshot: { messages: [oldTurn, keptTurn] },
  })
  return { live, laneId, sessionFile, frames, subscriptions, subscribe }
}

it.each(['connected', 'reconnecting'])(
  'sends only stopped composer metadata to a %s loaded chat',
  async (client) => {
    const { live, laneId, frames, subscriptions, subscribe } = await openChat()
    const cursor = live.streams.cursor(laneId)
    if (client === 'reconnecting') subscriptions.handle({ type: 'unsubscribe', id: 'open' })
    // Exercise the production order: exit can already have published the stopped summary.
    live.push(laneId, { kind: 'exit', expected: true, code: 0, signal: null })
    live.detach(laneId)
    if (client === 'reconnecting') subscribe('again', cursor)
    await Promise.resolve()
    expect(frames.filter((frame) => frame.type === 'snapshot')).toEqual([])
    expect(frames.at(-1)).toMatchObject({
      type: 'event',
      event: {
        kind: 'summary',
        summary: { activity: 'stopped' },
        stoppedComposer: { model: { provider: 'custom', id: 'model' }, tokens: 42_000 },
      },
    })
    // The ordinary preview is still available to a newly opened chat, not sent to the old one.
    subscribe('fresh')
    await Promise.resolve()
    expect(frames.at(-1)).toMatchObject({
      type: 'snapshot',
      id: 'fresh',
      snapshot: { state: null },
    })
    const fresh = frames.at(-1)
    expect(fresh?.type === 'snapshot' && fresh.snapshot.messages).not.toContainEqual(oldTurn)
  },
)

it('closes the watch if the saved transcript is unreadable at detach', async () => {
  const { live, laneId, sessionFile, frames } = await openChat()
  writeFileSync(sessionFile, 'not a transcript')
  live.detach(laneId)
  await Promise.resolve()
  expect(frames.at(-1)).toMatchObject({ type: 'subscribe-failed', code: 'unknown-lane' })
})
