// @vitest-environment jsdom
import { expect, it } from 'vitest'
import { mockOpsInvoke } from '@/dev/mock/ops'
import { AGENT_POLICY_DEFAULT } from '@phosphor/shared/ops'

it('keeps the edited policy, undo and pending approvals on the chosen mock machine', async () => {
  const local = { kind: 'local' },
    host = { kind: 'remote', hostId: 'sample' }
  const run = (target: typeof local, op: string, args: Record<string, unknown> = {}) =>
    mockOpsInvoke([target, { op, args }])
  expect(await run(host, 'policy.show')).toMatchObject({ status: 'denied', code: 'unsupported' })
  localStorage.setItem('mock:ops', '1')
  await run(local, 'policy.set', { policy: { ...AGENT_POLICY_DEFAULT, agentControl: 'off' } })
  expect(await run(local, 'policy.show')).toMatchObject({
    data: { policy: { agentControl: 'off' } },
  })
  expect(await run(host, 'policy.show')).toMatchObject({
    data: { policy: { agentControl: 'all' } },
  })
  const list = await run(local, 'confirm.list')
  if (list.status !== 'ok' || !Array.isArray(list.data)) throw Error('missing list')
  const id = String(list.data[0].confirmId)
  await run(local, 'confirm.deny', { confirmId: id })
  expect(await run(local, 'confirm.list')).toMatchObject({ data: [] })
  expect(await run(host, 'confirm.info', { confirmId: id })).toMatchObject({
    data: { state: 'pending' },
  })
  const audit = await run(host, 'audit.list')
  if (audit.status !== 'ok' || !Array.isArray(audit.data)) throw Error('missing audit')
  const auditId = String(audit.data[0].id)
  await run(host, 'audit.undo', { auditId })
  expect(await run(host, 'audit.list')).toMatchObject({ data: [{ undo: false, undoneBy: 'You' }] })
})
