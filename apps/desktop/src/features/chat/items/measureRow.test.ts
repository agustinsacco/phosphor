import { describe, expect, it, vi } from 'vitest'
import { attachRow, type RowMeasurer } from './measureRow'

function measurer(): RowMeasurer<{ index: number }> & { calls: string[] } {
  const calls: string[] = []
  return {
    calls,
    measureElement: (el) => calls.push(`observe:${el ? el.index : 'null'}`),
    indexFromElement: (el) => el.index,
    resizeItem: (index, size) => calls.push(`resize:${index}=${size}`),
  }
}

describe('attachRow', () => {
  it('measures a mounted row in the same call that hands it to the virtualizer', () => {
    const v = measurer()
    attachRow(v, () => 199, { index: 7 })
    // Observe first, so the virtualizer's ResizeObserver still tracks later
    // growth; the synchronous size is what the follow effect reads this frame.
    expect(v.calls).toEqual(['observe:7', 'resize:7=199'])
  })

  it('only releases on unmount', () => {
    const v = measurer()
    const size = vi.fn(() => 199)
    attachRow(v, size, null)
    expect(v.calls).toEqual(['observe:null'])
    expect(size).not.toHaveBeenCalled()
  })
})
