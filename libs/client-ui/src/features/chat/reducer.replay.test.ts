import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { emptyChatSession, reduceChatEvent, type AssistantItem } from './reducer'
import type { PiEvent } from '@shared/rpc'

/**
 * Replay a REAL captured pi RPC event stream (write + read + bash tools)
 * through the reducer and assert the final view-model is coherent.
 * Fixture: src/features/chat/__fixtures__/real-session-events.jsonl
 */
describe('chat reducer — real event stream replay', () => {
  const fixturePath = join(
    dirname(fileURLToPath(import.meta.url)),
    '__fixtures__',
    'real-session-events.jsonl',
  )
  const records = readFileSync(fixturePath, 'utf8')
    .trim()
    .split('\n')
    .map((line) => JSON.parse(line) as { type: string })
    .filter((record) => record.type !== 'response') as PiEvent[]

  it('folds the whole session without losing tools or leaving placeholders', () => {
    let state = emptyChatSession()
    for (const event of records) {
      state = reduceChatEvent(state, event as PiEvent)
    }

    expect(state.isStreaming).toBe(false)

    // The user prompt echo arrives via message_end (no optimistic local add here).
    const userItems = state.items.filter((i) => i.kind === 'user')
    expect(userItems.length).toBeGreaterThanOrEqual(1)

    // Three tools ran: write, read, bash — all completed, none errored.
    const toolStates = Object.values(state.tools)
    expect(toolStates).toHaveLength(3)
    expect(toolStates.map((t) => t.toolName).sort()).toEqual(['bash', 'read', 'write'])
    for (const tool of toolStates) {
      expect(tool.status).toBe('done')
      expect(tool.result).toBeTruthy()
      expect(tool.args).toBeTruthy()
    }

    // No placeholder tool ids survived reconciliation.
    expect(Object.keys(state.tools).some((id) => id.startsWith('pending-'))).toBe(false)

    // Every assistant item is finalized with a stop reason and closed blocks.
    const assistants = state.items.filter((i): i is AssistantItem => i.kind === 'assistant')
    expect(assistants.length).toBeGreaterThanOrEqual(3)
    for (const assistant of assistants) {
      expect(assistant.streaming).toBe(false)
      expect(assistant.stopReason).toBeTruthy()
      for (const block of assistant.blocks) {
        if (block.type === 'tool') {
          expect(state.tools[block.toolCallId]).toBeTruthy()
        } else {
          expect(block.closed).toBe(true)
        }
      }
    }

    // The final assistant message ends with text (the summary sentence).
    const last = assistants.at(-1)!
    expect(last.stopReason).toBe('stop')
    expect(last.blocks.some((b) => b.type === 'text' && b.text.length > 0)).toBe(true)
  })

  it('streams incrementally: text grows monotonically within a message', () => {
    let state = emptyChatSession()
    let lastLength = 0
    let currentAssistant: string | null = null

    for (const event of records) {
      state = reduceChatEvent(state, event as PiEvent)
      if ((event as PiEvent).type === 'message_start') {
        currentAssistant = null
        lastLength = 0
      }
      const assistants = state.items.filter((i): i is AssistantItem => i.kind === 'assistant')
      const tail = assistants.at(-1)
      if (!tail) continue
      if (currentAssistant === null) currentAssistant = tail.id
      if (tail.id !== currentAssistant) continue
      const textLength = tail.blocks
        .filter((b) => b.type === 'text')
        .reduce((sum, b) => sum + (b.type === 'text' ? b.text.length : 0), 0)
      expect(textLength).toBeGreaterThanOrEqual(lastLength)
      lastLength = textLength
    }
  })
})
