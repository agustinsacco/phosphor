import { Check } from 'typebox/value'
import { expect, it } from 'vitest'
import { OPS_LIMITS } from '../host-protocol-ops'
import { OP_CATALOG } from './index'

function spec(name: string) {
  const found = OP_CATALOG.find((x) => x.name === name)
  if (!found) throw Error(`Missing ${name}`)
  return found
}
const accepts = (name: string, args: unknown) => Check(spec(name).args, args)

it('accepts an optional file body up to 256 KiB of UTF-8, including on the structured path', () => {
  const fits = 'é'.repeat(OPS_LIMITS.contentBytes / 2)
  const cases = [
    ['files.create', { target: 'self', path: 'note' }],
    ['files.write', { target: 'self', path: 'note', expected: null }],
    ['instructions.edit', { revision: null }],
    ['config.write', { file: 'settings' }],
    ['skill.create', { scope: 'user', name: 'notes', description: 'Notes' }],
    ['skill.edit', { scope: 'user', name: 'notes' }],
  ] as const
  for (const [name, args] of cases) {
    expect(accepts(name, args), name).toBe(true)
    expect(accepts(name, { ...args, content: fits }), name).toBe(true)
    expect(accepts(name, { ...args, content: fits + 'a' }), name).toBe(false)
    expect(spec(name).sensitive).toContain('content')
  }
  expect(accepts('files.read', { target: 'self', path: 'note', content: 'surprise' })).toBe(false)
})
it('requires exactly one archive selection and bounds the exact id list', () => {
  expect(accepts('archive.purge', { ids: ['a', 'b'] })).toBe(true)
  expect(accepts('archive.purge', { all: true, removeWorktree: true })).toBe(true)
  for (const args of [
    {},
    { ids: [] },
    { ids: ['x', 'x'] },
    { ids: ['a'], all: true },
    { all: false },
    { ids: Array.from({ length: 201 }, (_, i) => String(i)) },
  ])
    expect(accepts('archive.purge', args)).toBe(false)
})
it('prevents trust, agent policy, credentials or client preferences riding on writable inputs', () => {
  for (const patch of [{ trusted: true }, { allowOps: ['*'] }, { enabled: true }])
    expect(accepts('routine.edit', { id: 'r', revision: 1, patch })).toBe(false)
  expect(
    accepts('routine.edit', { id: 'r', revision: 1, patch: { instructions: 'new task' } }),
  ).toBe(true)
  for (const key of ['agentControl', 'machineOps', 'webAccess.key', 'theme', 'worktree'])
    expect(accepts('settings.set', { key, value: 'change' })).toBe(false)
  expect(
    accepts('mcp.add', {
      name: 's',
      scope: 'global',
      config: { url: 'https://example.test', oauth: { clientSecret: 'fake' } },
    }),
  ).toBe(false)
  for (const name of ['config.read', 'config.write']) {
    const { tier } = spec(name)
    expect(typeof tier).toBe('function')
    if (typeof tier === 'function')
      for (const file of ['models', 'web-search'])
        expect(tier({ file }, { self: true })).toBe('never')
  }
  for (const op of [
    'lane.prompt',
    'lane.steer',
    'lane.followUp',
    'lane.abort',
    'lane.wait',
    'lane.message',
    'lane.bash',
    'lane.liveness',
  ])
    expect(OP_CATALOG.some((s) => s.name === op)).toBe(false)
})
it('distinguishes surface confirmation from creator status, never treating agents as approvers', () => {
  expect(spec('confirm.status')).toMatchObject({ tier: 'read' })
  expect(spec('confirm.status').surfaceOnly).toBeUndefined()
  for (const op of [
    'confirm.info',
    'confirm.list',
    'confirm.approve',
    'confirm.deny',
    'policy.set',
    'audit.undo',
  ])
    expect(spec(op).surfaceOnly).toBe(true)
  const confirmId = '00000000-0000-4000-8000-000000000001'
  for (const args of [{ confirmId }, { dialogId: 'dialog' }])
    expect(accepts('confirm.info', args)).toBe(true)
  for (const args of [{}, { confirmId, dialogId: 'dialog' }])
    expect(accepts('confirm.info', args)).toBe(false)
})
it('keeps agent Brain recall on the service queue and external text marked untrusted', () => {
  expect(OP_CATALOG.filter((s) => s.class === 'service').map((s) => s.name)).toEqual([
    'brain.search',
    'brain.flag',
  ])
  for (const op of [
    'brain.search',
    'lane.read',
    'archive.list',
    'artifact.read',
    'files.read',
    'git.show',
    'pr.detail',
  ])
    expect(spec(op).untrustedResult).toBe(true)
})
