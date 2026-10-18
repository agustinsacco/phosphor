import { afterEach, describe, expect, it, vi } from 'vitest'
import { isGone } from './lifecycle'

afterEach(() => vi.restoreAllMocks())

describe('process group errno adoption', () => {
  it('probes only the negative process group id with signal zero', () => {
    const kill = vi.spyOn(process, 'kill').mockReturnValue(true)
    expect(isGone(4242)).toBe(false)
    expect(kill).toHaveBeenCalledExactlyOnceWith(-4242, 0)
  })

  it.each([
    ['ESRCH Error', Object.assign(new Error('gone'), { code: 'ESRCH' }), true],
    ['ESRCH record', { code: 'ESRCH' }, true],
    ['EPERM Error', Object.assign(new Error('alive'), { code: 'EPERM' }), false],
    ['EPERM record', { code: 'EPERM' }, false],
    ['EIO Error', Object.assign(new Error('unknown'), { code: 'EIO' }), false],
    ['uncoded Error', new Error('unknown'), false],
    ['numeric code', { code: -3 }, false],
  ])('only ESRCH is gone: %s', (_name, error, gone) => {
    const kill = vi.spyOn(process, 'kill').mockImplementation(() => {
      throw error
    })
    expect(isGone(4242)).toBe(gone)
    expect(kill).toHaveBeenCalledExactlyOnceWith(-4242, 0)
  })
})
