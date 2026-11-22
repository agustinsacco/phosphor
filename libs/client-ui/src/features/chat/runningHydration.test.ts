import { describe, expect, it } from 'vitest'
import type { AgentMessage, PiEvent } from '@shared/rpc'
import { reduceChatEvent } from './reducer'
import { hydrateRunning } from './runningHydration'

const prompt: AgentMessage = { role: 'user', content: 'Check the Ledger read.', timestamp: 1 }
const earlier: AgentMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: 'Opened the Ledger read.' }],
  stopReason: 'stop',
  timestamp: 2,
}
const answer: AgentMessage = {
  role: 'assistant',
  content: [{ type: 'text', text: 'Approved the Ledger read.' }],
  stopReason: 'stop',
  timestamp: 4,
}
const delta = (text: string): PiEvent => ({
  type: 'message_update',
  assistantMessageEvent: { type: 'text_delta', contentIndex: 0, delta: text },
})
const texts = (state: ReturnType<typeof hydrateRunning>) =>
  state.items.map((item) =>
    item.kind === 'assistant'
      ? item.blocks.map((block) => (block.type === 'text' ? block.text : '')).join('')
      : item.kind === 'user'
        ? item.text
        : item.kind,
  )

describe('hydrateRunning', () => {
  it('gives an answer already streaming its own item, so later deltas never touch the last one', () => {
    let state = hydrateRunning([prompt, earlier], [delta('Approved ')])
    state = reduceChatEvent(state, delta('the Ledger read.'))
    expect(texts(state)).toEqual([
      'Check the Ledger read.',
      'Opened the Ledger read.',
      'Approved the Ledger read.',
    ])
    state = reduceChatEvent(state, { type: 'message_end', message: answer })
    expect(texts(state)).toEqual([
      'Check the Ledger read.',
      'Opened the Ledger read.',
      'Approved the Ledger read.',
    ])
  })

  it('gives an answer pi began before the lane opened its own item when none of it came during the load', () => {
    // pi sends message_start as the provider's stream opens; the first delta can come much later.
    const loaded = hydrateRunning([prompt, earlier], [])
    const expected = [
      'Check the Ledger read.',
      'Opened the Ledger read.',
      'Approved the Ledger read.',
    ]
    let state = reduceChatEvent(loaded, delta('Approved '))
    state = reduceChatEvent(state, delta('the Ledger read.'))
    expect(texts(state)).toEqual(expected)
    expect(texts(reduceChatEvent(state, { type: 'message_end', message: answer }))).toEqual(
      expected,
    )
    // One whose first event after the load is its end gets its own item too.
    expect(texts(reduceChatEvent(loaded, { type: 'message_end', message: answer }))).toEqual(
      expected,
    )
  })

  it('keeps a prompt and its answer once, whether or not the history already holds them', () => {
    const events: PiEvent[] = [
      { type: 'message_start', message: prompt },
      { type: 'message_end', message: prompt },
      { type: 'message_start', message: earlier },
      delta('Opened the Ledger read.'),
      { type: 'message_end', message: earlier },
    ]
    const expected = ['Check the Ledger read.', 'Opened the Ledger read.']
    expect(texts(hydrateRunning([], events))).toEqual(expected)
    expect(texts(hydrateRunning([prompt], events))).toEqual(expected)
    expect(texts(hydrateRunning([prompt, earlier], events))).toEqual(expected)
  })

  it('leaves a finished tool as its result says, and runs one the history has not finished', () => {
    const call = (toolCallId: string): PiEvent => ({
      type: 'tool_execution_start',
      toolCallId,
      toolName: 'brain_waiting',
      args: { limit: 60 },
    })
    const result: AgentMessage = {
      role: 'toolResult',
      toolCallId: 'done-call',
      toolName: 'brain_waiting',
      content: [{ type: 'text', text: '1 read waiting.' }],
      isError: false,
      timestamp: 3,
    }
    const state = hydrateRunning([prompt, result], [call('done-call'), call('next-call')])
    expect(state.tools['done-call']?.status).toBe('done')
    expect(state.tools['next-call']?.status).toBe('running')
  })

  it('shows a compaction that happened while the history loaded once', () => {
    const summary: AgentMessage = { role: 'compactionSummary', summary: 'Harbor work so far.' }
    const events: PiEvent[] = [
      { type: 'compaction_start', reason: 'threshold' },
      {
        type: 'compaction_end',
        reason: 'threshold',
        result: { summary: 'Harbor work so far.', firstKeptEntryId: 'e1', tokensBefore: 9000 },
        aborted: false,
      },
    ]
    for (const history of [[prompt], [summary, prompt]]) {
      const state = hydrateRunning(history, events)
      expect(state.items.filter((item) => item.kind === 'divider')).toHaveLength(1)
      expect(state.isCompacting).toBe(false)
    }
  })
})
