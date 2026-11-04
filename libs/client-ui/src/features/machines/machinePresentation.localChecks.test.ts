import { expect, it } from 'vitest'
import { localChecks, PI_INSTALL } from './machinePresentation'

it('describes missing pi on This Mac in words and offers the install command', () => {
  const [pi] = localChecks(
    { ok: false, reason: 'not-found', message: 'pi was not found on PATH.', minVersion: '0.70.0' },
    undefined,
    false,
  )
  expect(pi).toMatchObject({
    ok: false,
    detail: 'pi was not found on PATH.',
    command: PI_INSTALL,
  })
})
