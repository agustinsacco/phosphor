import { expect, it } from 'vitest'
import { laneLockCopy, NOBODY_HAS_CONTROL } from './laneLockCopy'

const phone = (connected: boolean) => ({ label: 'iPhone', connected, self: false })

it.each([
  ['nobody holds it', null, null, null, NOBODY_HAS_CONTROL, 'Take control', false],
  [
    'a disconnected holder',
    phone(false),
    null,
    'iPhone',
    'has control · disconnected',
    'Take control',
    false,
  ],
  [
    'a connected holder',
    phone(true),
    null,
    'iPhone',
    'has control · connected',
    'Take over…',
    true,
  ],
  [
    'it was just taken from you',
    phone(true),
    'iPhone',
    'iPhone',
    'took control from you.',
    'Take back…',
    true,
  ],
  [
    'its taker left',
    phone(false),
    'iPhone',
    'iPhone',
    'took control from you.',
    'Take back',
    false,
  ],
  [
    'someone else has it since',
    phone(true),
    'Desk',
    'iPhone',
    'has control · connected',
    'Take over…',
    true,
  ],
] as const)(
  'a reader of a lane %s',
  (_case, controller, takenBy, holder, message, label, confirm) => {
    expect(laneLockCopy({ controller, canTake: true, takenBy })).toEqual({
      holder,
      message,
      action: { label, confirm },
    })
  },
)

it('offers nothing to take, and says why, when this client cannot take the lane', () => {
  expect(
    laneLockCopy({ controller: phone(true), canTake: false, takenBy: null, hint: 'No.' }),
  ).toEqual({ holder: null, message: 'No.', action: null })
  expect(laneLockCopy({ controller: null, canTake: false, takenBy: null }).message).toBe(
    'Read-only.',
  )
})
