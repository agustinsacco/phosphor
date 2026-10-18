import { afterEach, expect, it, vi } from 'vitest'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { createTurns } from './turns.cjs'
import { createSession, persist } from './persistence.cjs'

const roots: string[] = []
afterEach(() => {
  vi.useRealTimers()
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true })
})

function fixture(env = {}) {
  vi.useFakeTimers()
  const root = mkdtempSync(join(tmpdir(), 'fake-turns-'))
  roots.push(root)
  const session = createSession({
    sessionFile: undefined,
    folder: root,
    cwd: root,
    launchName: undefined,
  })
  const trace: { port: string; record: Record<string, unknown> }[] = []
  const turns = createTurns(
    session,
    {
      cwd: root,
      text: (text: string) => ({ role: 'assistant', content: [{ type: 'text', text }] }),
      out: (record: Record<string, unknown>) => trace.push({ port: 'out', record }),
      persist: (record: Record<string, unknown>) => {
        trace.push({ port: 'persist', record })
        persist(session, record)
      },
    },
    env,
  )
  return { root, session, trace, turns }
}

it('persists the assistant between message_end and agent_end before settling and publishing the queue', () => {
  const h = fixture()
  h.turns.prompt('PHX-token\u2028and\u2029text')
  expect(h.trace.slice(0, 5).map(({ port, record }) => [port, record.type ?? record.role])).toEqual(
    [
      ['persist', 'user'],
      ['out', 'agent_start'],
      ['out', 'message_start'],
      ['out', 'message_end'],
      ['out', 'message_start'],
    ],
  )
  vi.advanceTimersByTime(10)
  expect(h.trace.slice(-5).map(({ port, record }) => [port, record.type ?? record.role])).toEqual([
    ['out', 'message_end'],
    ['persist', 'assistant'],
    ['out', 'agent_end'],
    ['out', 'agent_settled'],
    ['out', 'queue_update'],
  ])
  const disk = readFileSync(h.session.sessionFile, 'utf8')
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line))
  expect(disk.slice(1).map((entry) => entry.message)).toEqual(h.session.messages)
  expect(disk[2].parentId).toBe(disk[1].id)
  expect(h.session.messages).toMatchObject([
    { role: 'user', content: 'PHX-token\u2028and\u2029text' },
    { role: 'assistant', stopReason: 'stop', content: [{ text: 'PHX-token' }] },
  ])
})

it('aborts streams once and consumes mixed queues in insertion order with one user entry each', () => {
  const h = fixture()
  h.turns.prompt('stream')
  vi.advanceTimersByTime(40)
  h.turns.enqueue('PHX-follow', 'followUp')
  h.turns.enqueue('PHX-steer', 'steer')
  expect(h.trace.at(-1)?.record).toEqual({
    type: 'queue_update',
    steering: ['PHX-steer'],
    followUp: ['PHX-follow'],
  })
  h.turns.abort()
  h.turns.abort()
  expect(h.turns.state.streaming).toBeNull()
  vi.advanceTimersByTime(40)
  expect(h.session.messages).toMatchObject([
    { role: 'user', content: 'stream' },
    { stopReason: 'aborted', content: [{ text: '1 2 ' }] },
    { role: 'user', content: 'PHX-follow' },
    { content: [{ text: 'PHX-follow' }] },
    { role: 'user', content: 'PHX-steer' },
    { content: [{ text: 'PHX-steer' }] },
  ])
  expect(h.turns.state.queued).toEqual([])
  expect(h.trace.filter(({ record }) => record.type === 'agent_settled')).toHaveLength(3)
})

it('releases controlled streams, completes ordinary slow turns and preserves timeout errors', () => {
  const h = fixture()
  const release = join(h.root, 'release')
  h.turns.prompt(`slow-until ${release}`)
  vi.advanceTimersByTime(260)
  expect(h.turns.state.streaming).not.toBeNull()
  writeFileSync(release, '')
  vi.advanceTimersByTime(20)
  expect(h.turns.state.streaming).toBeNull()
  expect(h.session.messages.at(-1)).toMatchObject({ stopReason: 'stop' })
  h.turns.prompt('slow')
  vi.advanceTimersByTime(240)
  expect(h.turns.state.streaming).toBeNull()
  expect(h.session.messages.at(-1)).toMatchObject({
    stopReason: 'stop',
    content: [{ text: '1 2 3 4 5 6 7 8 9 10 11 12 ' }],
  })
  h.turns.prompt(`slow-until ${join(h.root, 'missing')}`)
  vi.advanceTimersByTime(60000)
  expect(h.session.messages.at(-1)).toMatchObject({
    stopReason: 'error',
    errorMessage: 'Fixture slow turn was not released within 10 seconds',
  })
  expect(vi.getTimerCount()).toBe(0)
})

it('recalls session tokens, routes attachments and tools, and emits provider failures', () => {
  const h = fixture()
  for (const message of [
    'PHX-remember',
    'recall',
    'PHX-hostinputs',
    'artifact links receipt-test',
    'auth-error',
  ]) {
    h.turns.prompt(message)
    vi.advanceTimersByTime(10)
  }
  expect(h.session.messages[3]).toMatchObject({ content: [{ text: 'PHX-remember' }] })
  expect(h.session.messages[5]).toMatchObject({
    content: [{ text: 'Attachments:  | 0 image/png' }],
  })
  expect(JSON.stringify(h.session.messages)).toContain('artifact_create')
  expect(JSON.stringify(h.session.messages)).toContain('nested/guide.md#L2')
  expect(JSON.stringify(h.session.messages)).toContain('toolResult')
  expect(h.session.messages.at(-1)).toMatchObject({
    stopReason: 'error',
    errorMessage: '401 unauthorized: login expired',
  })
})
