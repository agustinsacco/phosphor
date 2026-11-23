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
  command: vi.fn().mockResolvedValue({ success: true }),
  forLane: vi.fn(),
  broadcast: vi.fn(),
  policy: { version: 1, agentControl: 'all', machineOps: 'all', ops: {} as Record<string, 'ask'> },
}))
vi.mock('../broadcast', () => ({ broadcast: h.broadcast }))
vi.mock('../prefs/backend', () => ({ prefs: () => ({ get: () => h.policy }) }))
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
    { sessionId: 'mine', workspacePath: dir, client: { activity: { busy: true } } } as LiveSession,
    'My lane',
    true,
  )
  h.policy.ops = {}
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
