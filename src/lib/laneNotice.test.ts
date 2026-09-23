import { describe, it, expect } from 'vitest'
import type { AssistantItem, ChatItem } from '@/features/chat/chatItems'
import { EXCERPT_MAX, excerptOf, laneOutcome } from './laneNotice'

function assistant(text: string | string[], extra: Partial<AssistantItem> = {}): AssistantItem {
  const texts = Array.isArray(text) ? text : [text]
  return {
    id: Math.random().toString(36),
    kind: 'assistant',
    streaming: false,
    blocks: texts.map((t, index) => ({ type: 'text', index, text: t, closed: true })),
    ...extra,
  }
}

const user: ChatItem = { id: 'u', kind: 'user', text: 'do the thing' } as ChatItem

describe('laneOutcome', () => {
  it('previews the last reply', () => {
    expect(laneOutcome([user, assistant('All **tests** pass.')])).toEqual({
      kind: 'done',
      excerpt: 'All tests pass.',
    })
  })

  it('stays quiet for an aborted run', () => {
    expect(laneOutcome([user, assistant('partial', { stopReason: 'aborted' })])).toBeNull()
  })

  it('reports an error with its message', () => {
    expect(
      laneOutcome([user, assistant('', { stopReason: 'error', errorMessage: 'rate limited' })]),
    ).toEqual({ kind: 'error', excerpt: 'rate limited' })
  })

  it('skips a trailing tool-only step to find the prose', () => {
    const toolOnly: AssistantItem = {
      id: 't',
      kind: 'assistant',
      streaming: false,
      blocks: [{ type: 'tool', index: 0, toolCallId: 'x' }],
    }
    expect(laneOutcome([user, assistant('Done — PR opened.'), toolOnly])?.excerpt).toBe(
      'Done — PR opened.',
    )
  })

  it('ignores Claude Code tool markers', () => {
    expect(
      laneOutcome([user, assistant(['Fixed it.', '[Claude Code · Bash {"command":"ls"}]'])])
        ?.excerpt,
    ).toBe('Fixed it.')
  })

  it('does not reach past the prompt for an older reply', () => {
    expect(laneOutcome([assistant('old answer'), user])).toEqual({ kind: 'done' })
  })
})

describe('excerptOf', () => {
  it('takes the first meaningful line, not a heading marker or rule', () => {
    expect(excerptOf('---\n## Summary\n\nbody')).toBe('Summary')
  })

  it('drops code fences and keeps link text', () => {
    expect(excerptOf('```ts\nconst x = 1\n```\nSee [the docs](https://x.dev).')).toBe(
      'See the docs.',
    )
  })

  it('strips list bullets', () => {
    expect(excerptOf('- first item\n- second')).toBe('first item')
  })

  it('clamps on a word boundary with an ellipsis', () => {
    const long = 'word '.repeat(60)
    const excerpt = excerptOf(long)!
    expect(excerpt.length).toBeLessThanOrEqual(EXCERPT_MAX)
    expect(excerpt.endsWith('word…')).toBe(true)
  })

  it('returns undefined for nothing to say', () => {
    expect(excerptOf('   \n\n')).toBeUndefined()
  })
})
