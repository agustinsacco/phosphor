import { describe, expect, it, vi } from 'vitest'
import { renderToStaticMarkup } from 'react-dom/server'
import { createElement } from 'react'
import type { CustomMessage } from '@shared/rpc'
import request from './__fixtures__/subagent-supervisor-request.json'
import { emptyChatSession, hydrateFromMessages, reduceChatEvent } from './reducer'
import {
  parseSubagentNotice,
  subagentCall,
  subagentRun,
  summarizeSubagentCall,
} from './subagentRuns'
import { SubagentNoticeItem } from './items/SubagentNotice'

vi.mock('@/components/markdown/Markdown', () => ({
  Markdown: ({ text }: { text: string }) => createElement('p', null, text),
}))

// Fixture follows pi-subagents 0.76.1's native supervisor channel, not a live request.
describe('native subagent coordination', () => {
  const message = request as CustomMessage
  it('keeps exact native details and time in live and resumed history', () => {
    const live = reduceChatEvent(emptyChatSession(), { type: 'message_end', message })
    const replay = hydrateFromMessages([message])
    for (const state of [live, replay]) {
      expect(state.items[0]).toMatchObject({
        details: request.details,
        timestamp: request.timestamp,
      })
    }
  })

  it('renders a historical parent question, never an invented human blocker', () => {
    const item = hydrateFromMessages([message]).items[0]!
    if (item.kind !== 'custom') throw new Error('Expected custom message')
    const html = renderToStaticMarkup(createElement(SubagentNoticeItem, { item }))
    expect(html).toContain('worker asked the parent for guidance')
    // One line until opened: the question and its identifiers are behind it.
    expect(html).toContain('aria-expanded="false"')
    expect(html).not.toContain('Use the shared parser?')
    expect(html).not.toContain('Waiting on you')
    expect(html).not.toContain('replyHint')
  })

  it('tolerates old and malformed details without losing the original text', () => {
    for (const details of [undefined, null, [], 42, { runId: 3 }]) {
      expect(parseSubagentNotice(message.customType, 'Original question', details)).toMatchObject({
        kind: 'question',
        body: 'Original question',
        runId: undefined,
      })
    }
    expect(parseSubagentNotice('other-extension', 'hello', {})).toBeNull()
  })

  it('renders a journaled reply with its original request identity', () => {
    expect(
      parseSubagentNotice('subagent_supervisor_reply', '', {
        ...request.details,
        message: 'Use the shared parser.',
      }),
    ).toMatchObject({
      kind: 'reply',
      requestId: 'question-a',
      runId: 'run-a',
      childIndex: 2,
      body: 'Use the shared parser.',
    })
  })
})

describe('current and legacy launch contracts', () => {
  it.each([true, './review.js', 'review'])('recognizes workflow %s', (workflow) => {
    const call = subagentCall({ workflow })
    expect(summarizeSubagentCall(call, null, true).label).toBe('Running workflow')
  })
  it('keeps legacy scripts', () => {
    expect(subagentCall({ workflowScript: 'return 1' })).toMatchObject({ script: 'return 1' })
  })
  it('does not infer child success from a settled parent tool', () => {
    expect(subagentRun({ results: [{ agent: 'worker' }] }, true)?.children[0]?.status).toBe(
      'unknown',
    )
    expect(
      subagentRun({ results: [{ agent: 'worker', exitCode: 0 }] }, true)?.children[0]?.status,
    ).toBe('completed')
    expect(
      subagentRun({ progress: [{ agent: 'worker', status: 'paused' }] }, true)?.children[0]?.status,
    ).toBe('paused')
  })
})
