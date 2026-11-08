import { expect, it, vi } from 'vitest'
import brainForkGuard from './brain-fork-guard'

it('blocks every tool call, including unrecognised tools', () => {
  const on = vi.fn()
  brainForkGuard({ on })
  expect(on).toHaveBeenCalledWith('tool_call', expect.any(Function))
  const guard = on.mock.calls[0]![1] as () => unknown
  expect(guard()).toEqual({ block: true, reason: 'Knowledge extraction has no tools.' })
})
