import { describe, expect, it } from 'vitest'
import type { AgentMessage } from '@phosphor/shared/rpc'
import { hostLaneReceipt } from './receipt'
const meta = { title: 'Lane', repository: 'repo', branch: 'main' }
const user = (timestamp?: number): AgentMessage => ({ role: 'user', content: 'task', timestamp })
const answer = (text: string, timestamp?: number): AgentMessage => ({
  role: 'assistant',
  content: [{ type: 'text', text }],
  stopReason: 'stop',
  timestamp,
})
describe('hostLaneReceipt', () => {
  it('uses only the last settled run, ignores a newer in-flight prompt and formats excerpts', () => {
    expect(
      hostLaneReceipt([user(0), answer('old', 5), user(10), answer('## Done', 20), user(30)], meta),
    ).toMatchObject({ ...meta, durationMs: 10, settledAt: 20, excerpt: 'Done', outcome: 'done' })
  })
  it('prefers in-memory timing and includes queued messages in its span', () => {
    const messages: AgentMessage[] = [
      user(0),
      answer('old', 5),
      user(10),
      {
        role: 'assistant',
        content: [
          {
            type: 'toolCall',
            id: 'a',
            name: 'write',
            arguments: { path: '/repo/a', content: 'x' },
          },
        ],
        stopReason: 'toolUse',
        timestamp: 12,
      },
      {
        role: 'toolResult',
        toolCallId: 'a',
        toolName: 'write',
        content: [],
        isError: false,
        timestamp: 13,
      },
      user(15),
      answer('Done', 20),
    ]
    expect(hostLaneReceipt(messages, meta, { start: 11, end: 25 }, '/repo')).toMatchObject({
      durationMs: 14,
      settledAt: 25,
      files: 1,
      added: 1,
      excerpt: 'Done',
    })
  })
  it('hides unavailable and invalid duration and reports Stopped', () => {
    expect(hostLaneReceipt([user(), answer('Done')], meta)).toMatchObject({
      durationMs: null,
      settledAt: null,
    })
    expect(
      hostLaneReceipt([user(10), answer('Done', 20)], meta, { start: NaN, end: 30 }).durationMs,
    ).toBe(10)
    expect(hostLaneReceipt([user(20), answer('Done', 10)], meta).durationMs).toBeNull()
    expect(
      hostLaneReceipt(
        [
          user(10),
          {
            ...answer('', 20),
            role: 'assistant',
            content: [],
            stopReason: 'error',
            errorMessage: '**failed**',
          },
        ],
        meta,
      ),
    ).toMatchObject({ outcome: 'error', excerpt: 'failed' })
  })
  it('skips legacy provider call and result markers', () => {
    expect(
      hostLaneReceipt(
        [
          user(0),
          {
            role: 'assistant',
            content: [
              { type: 'text', text: 'Done' },
              { type: 'text', text: '[Claude Code · Bash {"command":"ls"}]' },
              { type: 'text', text: '[Claude Code · result #one {}]' },
            ],
            stopReason: 'stop',
            timestamp: 10,
          },
        ],
        meta,
      ).excerpt,
    ).toBe('Done')
    expect(hostLaneReceipt([user(), answer('[Claude Code · Bash {}]')], meta).excerpt).toBeNull()
  })
})
