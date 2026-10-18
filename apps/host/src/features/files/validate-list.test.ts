import { describe, expect, it, vi } from 'vitest'
import { validateList } from './validate-list'

function deferred() {
  let resolve!: () => void
  let reject!: (error: unknown) => void
  const promise = new Promise<void>((yes, no) => {
    resolve = yes
    reject = no
  })
  return { promise, resolve, reject }
}
const tick = () => new Promise<void>((resolve) => setImmediate(resolve))

describe('validateList', () => {
  it('does no work for an empty bounded list', async () => {
    const check = vi.fn()
    await validateList([], check)
    expect(check).not.toHaveBeenCalled()
  })
  it.each([1, 7, 8, 9, 31])(
    'validates %i entries once with at most eight workers',
    async (count) => {
      const files = Array.from({ length: count }, (_, i) => `file-${i}`)
      let active = 0,
        peak = 0
      const started: string[] = []
      await validateList(files, async (file) => {
        started.push(file)
        active++
        peak = Math.max(peak, active)
        await Promise.resolve()
        active--
      })
      expect(started).toEqual(files)
      expect(peak).toBe(Math.min(count, 8))
      expect(active).toBe(0)
    },
  )
  it('stops scheduling on failure and drains every active success and rejection', async () => {
    const files = Array.from({ length: 20 }, (_, i) => `file-${i}`)
    const gates = Array.from({ length: 8 }, deferred)
    const first = new Error('first')
    const later = new Error('later')
    const unhandled = vi.fn()
    process.on('unhandledRejection', unhandled)
    const check = vi.fn((file: string) => {
      const gate = gates[Number(file.slice(5))]
      if (!gate) throw new Error('scheduled after failure')
      return gate.promise
    })
    let settled = false
    const run = validateList(files, check)
    void run.then(
      () => {
        settled = true
      },
      () => {
        settled = true
      },
    )
    const rejected = expect(run).rejects.toBe(first)
    try {
      expect(check).toHaveBeenCalledTimes(8)
      gates[0]!.reject(first)
      await tick()
      expect(settled).toBe(false)
      expect(check).toHaveBeenCalledTimes(8)
      gates[1]!.reject(later)
      await tick()
      expect(settled).toBe(false)
      for (const gate of gates.slice(2)) gate.resolve()
      await rejected
      await tick()
      expect(settled).toBe(true)
      expect(check).toHaveBeenCalledTimes(8)
      expect(unhandled).not.toHaveBeenCalled()
    } finally {
      for (const gate of gates) gate.resolve()
      process.off('unhandledRejection', unhandled)
    }
  })
  it('preserves even undefined rejection reasons instead of treating them as success', async () => {
    await expect(
      validateList(['file'], async () => {
        throw undefined
      }),
    ).rejects.toBeUndefined()
  })
  it('stops before starting another worker after a synchronous throw', async () => {
    const error = new Error('sync')
    const check = vi.fn(() => {
      throw error
    })
    await expect(validateList(['a', 'b', 'c'], check)).rejects.toBe(error)
    expect(check).toHaveBeenCalledOnce()
  })
})
