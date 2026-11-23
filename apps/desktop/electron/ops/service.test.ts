import { mkdtemp, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { OP_CATALOG, OP_GAPS } from '@phosphor/shared/ops-catalog'
import { DISPATCHER_OPS } from '@phosphor/session-runtime/ops/judge'
import { openDesktopOps } from './service'
import { rememberOpLane } from './lanes'
import type { LiveSession } from '@phosphor/session-runtime/pi/session-registry'

const h = vi.hoisted(() => ({
  pins: [] as string[],
  command: vi.fn().mockResolvedValue({ success: true }),
  forLane: vi.fn(),
  broadcast: vi.fn(),
  policy: { version: 1, agentControl: 'all', machineOps: 'all', ops: {} as Record<string, 'ask'> },
}))
vi.mock('../broadcast', () => ({ broadcast: h.broadcast }))
vi.mock('../prefs/backend', () => ({
  prefs: () => ({
    get: () => h.policy,
    set: (_: string, policy: typeof h.policy) => {
      h.policy = policy
    },
  }),
}))
vi.mock('../store', () => ({
  getPrefs: () => ({ pinnedSessions: h.pins }),
  setPinnedSessions: (pins: string[]) => {
    h.pins = pins
  },
}))
vi.mock('../pi/session-runtime', () => ({ desktopSessions: { command: h.command } }))
vi.mock('../brain/runtime', () => ({ brainService: async () => ({ forLane: h.forLane }) }))
vi.mock('../debug-log', () => ({ log: vi.fn() }))
let dir: string
let owner: ReturnType<typeof openDesktopOps>
let forget: () => void
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'desktop-ops-'))
  owner = openDesktopOps(dir)
  forget = rememberOpLane(
    {
      sessionId: 'mine',
      workspacePath: dir,
      client: { sessionFile: join(dir, 'mine.jsonl'), activity: { busy: true } },
    } as LiveSession,
    'My lane',
    true,
  )
  h.policy.ops = {}
  h.pins = []
})
afterEach(async () => {
  forget()
  owner.close()
  await rm(dir, { recursive: true, force: true })
  vi.clearAllMocks()
})
const tool = (argv: string[]) =>
  owner.dispatcher.runFromTool('mine', {
    v: 1,
    id: 'test',
    argv,
    reason: 'needed',
    deadlineMs: 30000,
  })
it('resolves exactly the non-gap desktop catalog', () => {
  expect([...Object.keys(owner.handlers), ...DISPATCHER_OPS].sort()).toEqual(
    OP_CATALOG.filter((s) => !OP_GAPS.desktop[s.name])
      .map((s) => s.name)
      .sort(),
  )
})
it('audits locally, applies model through the service only after settle, and never asks a routine', async () => {
  expect(await tool(['model', 'set', 'my-provider/model'])).toMatchObject({
    status: 'ok',
    auditId: expect.any(String),
    effects: [{ kind: 'notify', level: 'info', message: expect.any(String) }],
  })
  expect(h.command).not.toHaveBeenCalledWith('mine', expect.objectContaining({ type: 'set_model' }))
  await owner.dispatcher.settled('mine', {})
  expect(h.command).toHaveBeenCalledWith('mine', {
    type: 'set_model',
    provider: 'my-provider',
    modelId: 'model',
  })
  expect((await stat(join(dir, 'agent-ops.sqlite'))).isFile()).toBe(true)
  h.policy.ops = { 'model.set': 'ask' }
  expect(await tool(['model', 'set', 'p/m'])).toMatchObject({ code: 'unattended' })
})
it('serves a search and its numbered flag through the same owner-scoped Brain port', async () => {
  const port = {
    search: vi.fn(async () => ({ text: 'Briefing', data: { status: 'ok', memories: 2 } })),
    flag: vi.fn(async () => ({ text: 'Flagged', data: { status: 'filed' } })),
  }
  h.forLane.mockReturnValue(port)
  const send = (op: string, input: Record<string, unknown>) =>
    owner.dispatcher.runFromTool('mine', {
      v: 1,
      id: 'test',
      op,
      input,
      reason: 'correction',
      deadlineMs: 10000,
    })
  expect(await send('brain.search', { query: 'topic' })).toMatchObject({
    status: 'ok',
    text: 'Briefing',
    data: { memories: 2 },
  })
  expect(
    await send('brain.flag', { ref: 1, problem: 'wrong', reason: 'correction' }),
  ).toMatchObject({ status: 'ok', text: 'Flagged' })
  expect(h.forLane).toHaveBeenCalledExactlyOnceWith({
    sessionId: 'mine',
    title: 'My lane',
    cwd: dir,
  })
})
const surface = { kind: 'surface', clientId: 'view', via: 'owner', label: 'This Mac' } as const
it('reads a departed lane’s redacted audit by its original ref, including equal-time pages', async () => {
  const at = Date.now()
  const time = vi.spyOn(Date, 'now').mockReturnValue(at)
  try {
    owner.close()
    owner = openDesktopOps(dir)
    await tool(['notify', 'private text'])
    await tool(['whoami'])
    forget()
    const list = (page?: string) =>
      owner.dispatcher.run(surface, {
        op: 'audit.list',
        args: { lane: 'local/session:mine', limit: 1 },
        page,
      })
    const first = await list()
    expect(first).toMatchObject({ status: 'ok', data: [{ op: 'whoami', at }] })
    if (first.status !== 'ok' || !first.next) throw new Error('expected another page')
    const second = await list(first.next)
    expect(second).toMatchObject({
      status: 'ok',
      data: [{ op: 'notify', argsSummary: '{"text":"[redacted]"}' }],
    })
    expect(second).not.toHaveProperty('next')
  } finally {
    time.mockRestore()
  }
})
it('binds an attended confirmation to one surface answer, and redeems it only once', async () => {
  forget()
  forget = rememberOpLane(
    {
      sessionId: 'mine',
      workspacePath: dir,
      client: { sessionFile: join(dir, 'mine.jsonl'), activity: { busy: true } },
    } as LiveSession,
    'My lane',
    false,
  )
  h.policy.ops = { 'model.set': 'ask' }
  const argv = ['model', 'set', 'p/m']
  const planned = await tool(argv)
  expect(planned.status).toBe('confirm')
  if (planned.status !== 'confirm') throw new Error('expected ask')
  const { confirmId, digest, title, message } = planned
  owner.dispatcher.confirmSeen('mine', { id: 'dialog', title, message })
  const answer = { type: 'extension_ui_response', id: 'dialog', confirmed: true } as const
  expect(owner.dispatcher.surfaceAnswered('mine', answer, 'machine')).toBe('forbidden')
  expect(
    await owner.dispatcher.run(surface, { op: 'confirm.info', args: { dialogId: 'dialog' } }),
  ).toMatchObject({ status: 'ok', data: { confirmId, state: 'pending' } })
  expect(owner.dispatcher.surfaceAnswered('mine', answer, 'surface')).toBe('relay')
  const redeem = () =>
    owner.dispatcher.runFromTool('mine', {
      v: 1,
      id: 'resubmit',
      argv,
      reason: 'needed',
      confirm: { confirmId, digest },
      deadlineMs: 10000,
    })
  expect(await redeem()).toMatchObject({ status: 'ok' })
  expect(await redeem()).toMatchObject({ code: 'confirm-expired' })
  expect(
    await owner.dispatcher.run(surface, {
      op: 'confirm.info',
      args: { confirmId: '00000000-0000-4000-8000-000000000000' },
    }),
  ).toMatchObject({ code: 'confirm-expired' })
})

it('persists a surface policy edit and notifies the settings view', async () => {
  const policy = { ...h.policy, ops: { 'lane.pin': 'ask' as const } }
  expect(await owner.dispatcher.run(surface, { op: 'policy.set', args: { policy } })).toMatchObject(
    { status: 'ok' },
  )
  expect(await owner.dispatcher.run(surface, { op: 'policy.show', args: {} })).toMatchObject({
    data: { policy },
  })
  expect(h.broadcast).toHaveBeenCalledWith('ops:changed', { machine: 'local', kind: 'policy' })
})
it('undoes a real audited pin as the owner surface', async () => {
  const pin = await tool(['lane.pin', 'on'])
  if (pin.status !== 'ok' || !pin.auditId) throw new Error(JSON.stringify(pin))
  expect(h.pins).toEqual([join(dir, 'mine.jsonl')])
  expect(
    await owner.dispatcher.run(surface, { op: 'audit.undo', args: { auditId: pin.auditId } }),
  ).toMatchObject({ status: 'ok' })
  expect(h.pins).toEqual([])
})
it('refuses both user-only operations before looking up even a supplied confirmation', async () => {
  for (const [op, input] of [
    ['policy.set', { policy: h.policy }],
    ['audit.undo', { auditId: 'change' }],
  ] as const) {
    expect(
      await owner.dispatcher.runFromTool('mine', {
        v: 1,
        id: 'try',
        op,
        input,
        deadlineMs: 1000,
        confirm: { confirmId: 'missing', digest: 'a'.repeat(64) },
      }),
    ).toMatchObject({ status: 'denied', code: 'never' })
  }
})
