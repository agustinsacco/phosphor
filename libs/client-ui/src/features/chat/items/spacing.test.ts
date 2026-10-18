import { describe, expect, it } from 'vitest'
import { spacingFor, STREAM_GAP } from './spacing'
import { buildTranscriptRows, type TranscriptRow } from './transcriptRows'
import type { AssistantItem, ChatItem, UserItem } from '../reducer'

const user = (id = 'u1'): UserItem => ({ id, kind: 'user', text: 'hi' })

const assistantText = (id = 'a1'): AssistantItem => ({
  id,
  kind: 'assistant',
  streaming: false,
  blocks: [{ type: 'text', index: 0, text: 'answer', closed: true }],
})

const assistantToolOnly = (id = 'a2'): AssistantItem => ({
  id,
  kind: 'assistant',
  streaming: false,
  blocks: [{ type: 'tool', index: 0, toolCallId: `t-${id}` }],
})

const divider = (id = 'd1'): ChatItem => ({ id, kind: 'divider', variant: 'compaction' })

const bash = (id = 'b1'): ChatItem => ({
  id,
  kind: 'bash',
  command: 'ls',
  output: '',
  exitCode: 0,
  running: false,
  truncated: false,
})

/** The row a single item produces, for pairwise boundary assertions. */
const rowOf = (item: ChatItem): TranscriptRow => {
  const rows = buildTranscriptRows([item])
  if (!rows[0]) throw new Error('item produced no row')
  return rows[0]
}

describe('spacingFor', () => {
  it('gives the first row no leading gap', () => {
    expect(spacingFor(undefined)).toBe('')
  })

  it('uses ONE step after any previous row, regardless of kind', () => {
    // The invariant that replaced the old boundary-aware 8/16px scheme: one
    // owner, one step. Anything that wants to look grouped does it with ink.
    const previousItems: ChatItem[] = [assistantText(), user(), divider(), bash()]
    for (const item of previousItems) {
      expect(spacingFor(rowOf(item))).toBe(STREAM_GAP)
    }
  })

  it('keeps the space around a tool group symmetric', () => {
    // Mid-turn: prose → activity → prose. The old scheme tightened the first
    // boundary and gave the answer a wider "final beat", so the card sat 4px
    // from the text above and 12px from the text below. Both sides must match.
    const rows = buildTranscriptRows([
      assistantText('a1'),
      assistantToolOnly('a2'),
      assistantText('a3'),
    ])
    expect(rows.map((r) => r.kind)).toEqual(['text', 'activity', 'text'])
    const aboveGroup = spacingFor(rows[0]!)
    const belowGroup = spacingFor(rows[1]!)
    expect(aboveGroup).toBe(STREAM_GAP)
    expect(aboveGroup).toBe(belowGroup)
  })

  it('gives every interior row an equal gap above and below', () => {
    // The property the transcript was missing: for any row, the leading space
    // it owns equals the leading space its successor owns.
    const rows = buildTranscriptRows([
      user('u1'),
      assistantToolOnly('a1'),
      assistantText('a2'),
      assistantToolOnly('a3'),
      assistantText('a4'),
      user('u5'),
    ])
    expect(rows.map((r) => r.kind)).toEqual([
      'item',
      'activity',
      'text',
      'activity',
      'text',
      'item',
    ])
    for (let i = 1; i < rows.length - 1; i++) {
      const above = spacingFor(rows[i - 1]!)
      const below = spacingFor(rows[i]!)
      expect(below).toBe(above)
    }
  })

  it('needs no tool-only special case: consecutive tool turns are ONE row', () => {
    // What `isToolOnlyTurn` used to paper over is now structural — pi's
    // one-message-per-tool-call runs merge before spacing is consulted.
    const rows = buildTranscriptRows([
      assistantToolOnly('a1'),
      assistantToolOnly('a2'),
      assistantToolOnly('a3'),
    ])
    expect(rows).toHaveLength(1)
    expect(rows[0]?.kind).toBe('activity')
  })

  it('never emits trailing padding (it doubled every gap)', () => {
    const rows = buildTranscriptRows([user(), assistantText(), assistantToolOnly()])
    const classes = [spacingFor(undefined), spacingFor(rows[0]!), spacingFor(rows[1]!)]
    for (const value of classes) expect(value).not.toMatch(/\bpb-/)
  })
})
