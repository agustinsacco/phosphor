import { expect, it } from 'vitest'
import { submitBehavior } from './submitBehavior'

it('keeps plain Enter as steering and supports follow-up modifiers on every platform', () => {
  const plain = { altKey: false, metaKey: false, ctrlKey: false }
  expect(submitBehavior(plain)).toBe('steer')
  for (const key of ['altKey', 'metaKey', 'ctrlKey']) {
    expect(submitBehavior({ ...plain, [key]: true })).toBe('followUp')
  }
})
