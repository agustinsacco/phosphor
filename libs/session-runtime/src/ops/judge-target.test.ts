import { expect, it } from 'vitest'
import { OP_CATALOG } from '@phosphor/shared/ops-catalog'
import { parseOpArgv } from '@phosphor/shared/ops-cli'
import { createOpsDispatcher } from './dispatcher'

import { agent, createHarness, OTHER, OWN, surface } from './__fixtures__/dispatcher-harness'

const write = (target: string) => ({
  op: 'files.write',
  args: { target, path: 'a.txt', content: 'x', expected: null },
  reason: 'fix',
})

it('asks before an agent writes into another lane’s folder', async () => {
  const h = createHarness()
  const result = await h.dispatcher.run(agent(), write(OTHER))
  expect(result.status).toBe('confirm')
  expect(h.calls.handled).toEqual([])
  expect(h.calls.created[0]?.lane?.ref).toBe(OTHER)
})

it('runs an agent’s write into its own lane at the op’s tier, with its own lane', async () => {
  const h = createHarness()
  expect((await h.dispatcher.run(agent(), write(OWN))).status).toBe('ok')
  expect(h.calls.handled[0]?.ctx.lane?.ref).toBe(OWN)
  expect(h.calls.audit[0]).toMatchObject({ tier: 'lane', scope: 'self', target: OWN })
})

it('lets an agent read another lane’s files without asking, and names that lane', async () => {
  const h = createHarness()
  const read = { op: 'files.read', args: { target: OTHER, path: 'a.txt' } }
  expect((await h.dispatcher.run(agent(), read)).status).toBe('ok')
  expect(h.calls.handled[0]?.ctx.lane?.ref).toBe(OTHER)
  expect(h.calls.audit[0]).toMatchObject({ scope: 'other-lane', target: OTHER })
})

it('gives a surface the lane its target names', async () => {
  const h = createHarness()
  expect((await h.dispatcher.run(surface(), write(OTHER))).status).toBe('ok')
  expect(h.calls.handled[0]?.ctx.lane?.ref).toBe(OTHER)
  const missing = await h.dispatcher.run(surface(), write('local/session:none'))
  expect(missing).toMatchObject({ status: 'denied', code: 'bad-request' })
})

it('leaves ui.open’s target alone: a view is not a lane', async () => {
  const h = createHarness()
  const open = { op: 'ui.open', args: { target: 'settings' }, reason: 'show' }
  expect((await h.dispatcher.run(agent(), open)).status).toBe('ok')
  expect(h.calls.handled[0]?.ctx.lane?.ref).toBe(OWN)
})

it('lists exactly the catalog ops whose target is a lane', () => {
  const withTarget = OP_CATALOG.filter((spec) => {
    const properties = (spec.args as { properties?: Record<string, unknown> }).properties
    return properties !== undefined && 'target' in properties && spec.name !== 'ui.open'
  }).map((spec) => spec.name)
  expect(
    OP_CATALOG.filter((spec) => spec.laneArg === 'target')
      .map((spec) => spec.name)
      .sort(),
  ).toEqual(withTarget.sort())
})

it.each([
  { argv: ['git', 'show', 'HEAD', 'README.md'], ref: 'HEAD', path: 'README.md' },
  {
    argv: ['pr', 'detail', 'https://github.com/example/repo/pull/42'],
    ref: 'https://github.com/example/repo/pull/42',
  },
  { argv: ['git', 'restoreFile', 'HEAD', 'README.md'], ref: 'HEAD', path: 'README.md', ask: true },
])('uses --target for the lane and preserves $ref', async ({ argv, ref, path, ask }) => {
  const h = createHarness()
  const dispatcher = createOpsDispatcher(h.binding, {
    ...h.deps,
    parseArgv: (argv, content) => parseOpArgv(argv, undefined, { content }),
  })
  const result = await dispatcher.runFromTool('s1', {
    v: 1,
    id: 'target',
    argv: [...argv, '--target', OTHER],
    reason: 'test',
    deadlineMs: 30_000,
  })
  if (ask) {
    expect(result.status).toBe('confirm')
    expect(h.calls.created[0]?.lane?.ref).toBe(OTHER)
  } else {
    expect(result.status).toBe('ok')
    expect(h.calls.handled[0]).toMatchObject({
      args: { target: OTHER, ref, ...(path ? { path } : {}) },
      ctx: { lane: { ref: OTHER } },
    })
  }
})

it('can inspect a busy, controlled lane under read-only policy', async () => {
  const h = createHarness({
    policy: { agentControl: 'read' },
    lanes: [
      {
        ref: OTHER,
        sessionId: 's2',
        title: 'Other',
        cwd: '/tmp',
        busy: true,
        controller: { clientId: 'other', label: 'Other' },
      },
    ],
  })
  const op = 'mcp.lane'
  const args = { ref: OTHER, server: 'fixture', action: 'inspect' }
  for (const principal of [agent(), surface()])
    expect(await h.run(principal, { op, args })).toMatchObject({ status: 'ok' })
  expect(h.calls.audit[0]?.tier).toBe('read')
})
