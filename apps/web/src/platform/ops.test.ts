import { expect, it } from 'vitest'
import { opsHandlers } from './ops'

it('answers ops:run in the browser as not served yet', () => {
  expect(opsHandlers()['ops:run']()).toEqual({
    status: 'denied',
    code: 'unsupported',
    text: 'This version of Phosphor does not run agent ops yet.',
  })
})
