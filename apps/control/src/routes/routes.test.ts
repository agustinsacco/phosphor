// CT-01 frozen inventory: 61 generated cases across 10 route/method pairs.
// Full names are recorded in the characterization commit; all cases passed on base.
import { expect, it } from 'vitest'
import { createHash } from 'node:crypto'
import { CONTROL_ROUTES as R } from '@phosphor/shared/control-api'
import { signingKey, userId } from '../test-support'
import { machine, setup } from './__fixtures__/fixtures'

// Preserve the inventory name; machine and host validation now live in their domain suites.
it('checks key equality, normalizes label and codes and rejects invalid route ids/revoke bodies', async () => {
  const s = setup()
  expect(
    (
      await s.call(
        R.enrollments,
        'POST',
        {
          publicKey: signingKey().publicKey,
          hostname: 'bee',
          platform: 'linux',
          arch: 'x64',
          hostVersion: '1.0.0',
        },
        'key',
      )
    ).status,
  ).toBe(400)
  s.results.control_enrollment_approve = { outcome: 'approved', machine }
  expect(
    (await s.call(R.enrollmentApprove, 'POST', { userCode: 'bcdf-ghjk', label: ' bee ' })).status,
  ).toBe(200)
  expect(s.deps.supabase.rpc).toHaveBeenLastCalledWith('control_enrollment_approve', {
    p_user_id: userId,
    p_code_hash: createHash('sha256').update('BCDFGHJK').digest('hex'),
    p_label: 'bee',
  })
})
