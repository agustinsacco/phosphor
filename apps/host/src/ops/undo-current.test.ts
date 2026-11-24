import { describe, expect, it, vi } from 'vitest'
import { undoCurrent } from './undo-current'

const entry = (op: string) => ({ op }) as Parameters<ReturnType<typeof undoCurrent>>[0]

describe('undoCurrent', () => {
  it('asks only the first family that claims the op', async () => {
    const settings = vi.fn(async () => true)
    const rest = vi.fn(async () => false)
    const check = undoCurrent([
      [(op) => op === 'settings.set', settings],
      [() => true, rest],
    ])
    expect(await check(entry('settings.set'))).toBe(true)
    expect(rest).not.toHaveBeenCalled()
    expect(await check(entry('lane.pin'))).toBe(false)
    expect(settings).toHaveBeenCalledTimes(1)
  })

  it('treats an op no family claims as not current', async () => {
    expect(await undoCurrent([[() => false, async () => true]])(entry('x'))).toBe(false)
  })
})
