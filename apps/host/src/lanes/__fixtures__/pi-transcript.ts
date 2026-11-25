/**
 * pi session files as pi writes them: a header line, then one entry per line,
 * each pointing at its parent. Only the fields the model readers look at.
 */
import { randomUUID } from 'node:crypto'

export type PiEntry = Record<string, unknown> & { id: string }

export const header = (id: string = randomUUID()) =>
  ({ type: 'session', version: 3, id, cwd: '/', timestamp: '2026-01-01T00:00:00.000Z' }) as const

export const modelChange = (id: string, provider: string, modelId: string): PiEntry => ({
  type: 'model_change',
  id,
  provider,
  modelId,
})

export const thinkingChange = (id: string, thinkingLevel: string): PiEntry => ({
  type: 'thinking_level_change',
  id,
  thinkingLevel,
})

export const userMessage = (id: string, text: string): PiEntry => ({
  type: 'message',
  id,
  message: { role: 'user', content: [{ type: 'text', text }] },
})

export const assistantMessage = (id: string, provider: string, model: string): PiEntry => ({
  type: 'message',
  id,
  message: { role: 'assistant', content: [{ type: 'text', text: 'done' }], provider, model },
})

/** One branch: each entry's parent is the one before it, unless it names its own. */
export function piTranscript(entries: readonly PiEntry[], sessionId?: string): string {
  let parentId: string | null = null
  const lines: unknown[] = [header(sessionId)]
  for (const entry of entries) {
    lines.push({ parentId, ...entry })
    parentId = entry.id
  }
  return `${lines.map((line) => JSON.stringify(line)).join('\n')}\n`
}

/** A lane that picked Claude, thought hard and got an answer. */
export const CLAUDE_LANE: readonly PiEntry[] = [
  modelChange('m1', 'pi-claude-cli', 'claude-opus-5'),
  thinkingChange('t1', 'high'),
  userMessage('u1', 'Fix the sidebar'),
  assistantMessage('a1', 'pi-claude-cli', 'claude-opus-5'),
]
