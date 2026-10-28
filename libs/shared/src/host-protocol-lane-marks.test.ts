import { describe, expect, it } from 'vitest'
import { parseClientFrame, UNFENCED_OPS } from './host-protocol'

const REQUEST = '00000000-0000-4000-8000-000000000002'
const LANE = '00000000-0000-4000-8000-000000000001'
const command = (op: unknown, fields: object = { laneId: LANE }) =>
  parseClientFrame(JSON.stringify({ type: 'command', requestId: REQUEST, op, ...fields }))
const accepted = (op: unknown, fields: object = { laneId: LANE }) => ({
  ok: true,
  frame: { type: 'command', requestId: REQUEST, op, ...fields },
})
const badRequest = {
  ok: false,
  reason: 'command',
  reply: { kind: 'receipt', requestId: REQUEST, code: 'bad-request' },
}
const marks = (fields: object) => ({ type: 'lane.marks', ...fields })

describe('lane.marks op', () => {
  it('accepts a pin, a marker choice, a forgotten marker and an explicit none', () => {
    for (const fields of [
      { pinned: true },
      { pinned: false },
      { marker: '🦊' },
      { marker: null },
      { marker: '' },
      { pinned: true, marker: '🚀' },
    ])
      expect(command(marks(fields))).toStrictEqual(accepted(marks(fields)))
  })

  it('accepts every picker glyph shape: variation selectors, ZWJ families and tag flags', () => {
    for (const marker of ['⚙️', '👨‍👩‍👧‍👦', '🏴󠁧󠁢󠁳󠁣󠁴󠁿', '🧑🏽‍💻', 'x'.repeat(32)])
      expect(command(marks({ marker }))).toStrictEqual(accepted(marks({ marker })))
  })

  it('refuses an empty change, wrong types, extra keys and unbounded or control glyphs', () => {
    for (const fields of [
      {},
      { pinned: 1 },
      { pinned: null },
      { marker: 1 },
      { marker: 'x'.repeat(33) },
      { marker: 'a\nb' },
      { marker: '\u0000' },
      { marker: '\u007f' },
      { marker: '\u0085' },
      { marker: '\u2028' },
      { marker: '\ud83e' },
      { pinned: true, extra: 1 },
    ])
      expect(command(marks(fields)), JSON.stringify(fields)).toStrictEqual(badRequest)
  })

  it('names its lane on the frame and is admitted without a fence', () => {
    expect(UNFENCED_OPS).toContain('lane.marks')
    expect(command(marks({ pinned: true }), { laneId: LANE, fence: 3 })).toStrictEqual(
      accepted(marks({ pinned: true }), { laneId: LANE, fence: 3 }),
    )
  })
})
