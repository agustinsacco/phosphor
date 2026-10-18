import { describe, expect, it } from 'vitest'
import { RATE_LIMIT_STATUS_KEY } from '@/features/chat/composer/rateLimit'
import type { SessionMeta } from '@shared/models'
import { bindingRateLimit, estimatedResidentMb, formatMb, topSpenders } from './accountUsage'

const status = (payload: Record<string, unknown>): Record<string, string> => ({
  [RATE_LIMIT_STATUS_KEY]: JSON.stringify(payload),
})

describe('bindingRateLimit', () => {
  it('is null when no live session runs a provider that reports one', () => {
    expect(bindingRateLimit({}, ['a', 'b'])).toBeNull()
    expect(bindingRateLimit({ a: { 'other-key': '{}' } }, ['a'])).toBeNull()
  })

  it('takes the highest utilization: a stale session under-reports the window', () => {
    const statuses = {
      stale: status({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.2 }),
      fresh: status({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.81 }),
    }
    expect(bindingRateLimit(statuses, ['stale', 'fresh'])?.utilization).toBe(0.81)
    // Order must not matter.
    expect(bindingRateLimit(statuses, ['fresh', 'stale'])?.utilization).toBe(0.81)
  })

  it('lets a capped window win outright, whatever the percentages say', () => {
    const statuses = {
      capped: status({ status: 'rejected', rateLimitType: 'seven_day' }),
      busy: status({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.99 }),
    }
    expect(bindingRateLimit(statuses, ['busy', 'capped'])?.status).toBe('rejected')
  })

  it('prefers a known percentage over an older provider that sent none', () => {
    const statuses = {
      old: status({ status: 'allowed', rateLimitType: 'five_hour' }),
      new: status({ status: 'allowed', rateLimitType: 'five_hour', utilization: 0.05 }),
    }
    expect(bindingRateLimit(statuses, ['old', 'new'])?.utilization).toBe(0.05)
  })

  it('ignores sessions that are not live', () => {
    const statuses = { gone: status({ status: 'allowed', utilization: 0.9 }) }
    expect(bindingRateLimit(statuses, [])).toBeNull()
  })
})

describe('resident memory', () => {
  it('scales with the number of live subprocesses', () => {
    expect(estimatedResidentMb(0)).toBe(0)
    expect(estimatedResidentMb(3)).toBe(600)
  })

  it('switches unit where the number stops being readable', () => {
    expect(formatMb(600)).toBe('600 MB')
    expect(formatMb(1200)).toBe('1.2 GB')
  })
})

describe('topSpenders', () => {
  const meta = (path: string, cost: number): SessionMeta =>
    ({ path, cost }) as unknown as SessionMeta

  it('drops free lanes and keeps the biggest, in order', () => {
    const out = topSpenders([meta('/a', 3), meta('/b', 0), meta('/c', 7)], 2)
    expect(out.map((m) => m.path)).toEqual(['/c', '/a'])
  })

  it('includes an idle lane, which is the one with no card to show it', () => {
    expect(topSpenders([meta('/idle', 9)]).map((m) => m.path)).toEqual(['/idle'])
  })

  it("does not reorder the caller's array", () => {
    const input = [meta('/a', 1), meta('/b', 5)]
    topSpenders(input)
    expect(input.map((m) => m.path)).toEqual(['/a', '/b'])
  })
})
