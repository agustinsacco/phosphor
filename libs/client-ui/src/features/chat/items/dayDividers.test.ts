import { describe, expect, it, vi } from 'vitest'
import { withDayDividers } from './dayDividers'
import type { ChatItem, DividerItem } from '../chatItems'

const NOW = new Date('2026-08-09T15:00:00').getTime()
const HOUR = 3_600_000

const user = (id: string, timestamp?: number): ChatItem => ({
  id,
  kind: 'user',
  text: `prompt ${id}`,
  ...(timestamp === undefined ? {} : { timestamp }),
})

const assistant = (id: string, timestamp?: number): ChatItem => ({
  id,
  kind: 'assistant',
  blocks: [],
  streaming: false,
  ...(timestamp === undefined ? {} : { timestamp }),
})

const bash = (id: string): ChatItem => ({
  id,
  kind: 'bash',
  command: 'ls',
  output: '',
  exitCode: 0,
  running: false,
  truncated: false,
})

const dividers = (items: ChatItem[]): DividerItem[] =>
  items.filter((item): item is DividerItem => item.kind === 'divider')

describe('withDayDividers', () => {
  it('opens the transcript with the day it starts on', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const out = withDayDividers([user('u1', NOW - HOUR), assistant('a1', NOW - HOUR)])
    expect(dividers(out).map((d) => d.summary)).toEqual(['Today'])
    expect(out.filter((i) => i.kind !== 'divider')).toHaveLength(2)
    vi.useRealTimers()
  })

  it('marks each day boundary once, not every message', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const yesterday = NOW - 30 * HOUR
    const out = withDayDividers([
      user('u1', yesterday),
      assistant('a1', yesterday),
      user('u2', NOW),
      assistant('a2', NOW),
    ])
    expect(out.map((item) => item.kind)).toEqual([
      'divider',
      'user',
      'assistant',
      'divider',
      'user',
      'assistant',
    ])
    expect(dividers(out).map((d) => d.summary)).toEqual(['Yesterday', 'Today'])
    vi.useRealTimers()
  })

  it('leaves a same-day transcript untouched', () => {
    const out = withDayDividers([user('u1', NOW - 5 * HOUR), assistant('a1', NOW - 4 * HOUR)])
    expect(dividers(out)).toHaveLength(1)
  })

  it('never invents a day for items that carry no timestamp', () => {
    // A bash run and a message with no time are not evidence of a day.
    expect(dividers(withDayDividers([bash('b1'), bash('b2'), user('u1')]))).toEqual([])
    // The first item that does carry a time opens the transcript's day, and the
    // divider sits directly above THAT item.
    const out = withDayDividers([bash('b1'), user('u2', NOW)])
    expect(out.map((item) => item.kind)).toEqual(['bash', 'divider', 'user'])
  })

  it('keeps the day it last saw across an untimestamped row', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const out = withDayDividers([user('u1', NOW - 30 * HOUR), bash('b1'), user('u2', NOW)])
    expect(out.map((item) => item.kind)).toEqual(['divider', 'user', 'bash', 'divider', 'user'])
    vi.useRealTimers()
  })

  it('names a divider after the item under it, so a stream never remounts it', () => {
    const items = [user('u1', NOW), assistant('a1', NOW)]
    expect(dividers(withDayDividers(items))[0]?.id).toBe('u1-day')
    // The same items produce the same ids on every delta of the stream.
    expect(withDayDividers(items)).toEqual(withDayDividers(items))
  })

  it('carries the instant so the tooltip can spell the date out', () => {
    vi.useFakeTimers()
    vi.setSystemTime(NOW)
    const [divider] = dividers(withDayDividers([user('u1', NOW)]))
    expect(divider?.at).toBe(NOW)
    vi.useRealTimers()
  })
})
