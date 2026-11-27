// @vitest-environment node
import { afterEach, describe, expect, it, vi } from 'vitest'
import { DEFAULT_BRAIN_PREFS } from '@phosphor/shared/brain'
import { BRAIN_APPROVAL, BRAIN_SURFACE } from '@phosphor/shared/host-brain'
import { OPS_LIMITS, type OpsRunResult } from '@phosphor/shared/host-protocol-ops'
import { brainHelp, parseBrainCli } from './cli-brain-args'
import { runCliBrain } from './cli-brain'
import type { CliContext } from './cli-handlers'
import { openLocalClient } from './local-client'
import type * as LocalClient from './local-client'

vi.mock('./local-client', async (original) => ({
  ...(await original<typeof LocalClient>()),
  openLocalClient: vi.fn(),
}))

const generation = '6513c7c5-866b-4df8-b991-69897e1d0234'
const laneId = '859ad058-4ce3-4be5-a1ef-b03d4b0150c6'
const expected = ['--expected', `${generation}:7`]
const confirmId = 'c0ffee00-0000-4000-8000-000000000000'
const ok = (action: unknown) => ({ ok: true, action, json: false })

describe('parseBrainCli', () => {
  it('targets this Host without a --host flag and refuses every --host value', () => {
    expect(parseBrainCli(['status', '--json'])).toEqual({
      ok: true,
      action: { method: 'brain:status', args: [] },
      json: true,
    })
    for (const host of ['local', 'all', 'Harbor', 'a,b']) {
      const refused = parseBrainCli(['status', '--host', host])
      expect(refused).toEqual({ ok: false, problem: expect.stringMatching(/this Host only/) })
      expect(JSON.stringify(refused)).not.toContain(host === 'local' ? '--host local' : host)
    }
  })

  it('takes plain operands for ordinary commands and fills defaults', () => {
    expect(parseBrainCli(['ask', 'Who owns Harbor?'])).toEqual(
      ok({ method: 'brain:ask', args: ['Who owns Harbor?'] }),
    )
    expect(parseBrainCli(['find', 'Harbor'])).toEqual(
      ok({ method: 'brain:find', args: ['Harbor', 20] }),
    )
    expect(parseBrainCli(['find', 'Harbor', '5'])).toEqual(
      ok({ method: 'brain:find', args: ['Harbor', 5] }),
    )
    expect(parseBrainCli(['changes'])).toEqual(ok({ method: 'brain:tidyChanges', args: [20] }))
    expect(parseBrainCli(['path', 'e1', 'e2'])).toEqual(
      ok({ method: 'brain:path', args: ['e1', 'e2'] }),
    )
    expect(parseBrainCli(['neighbourhood', 'e1'])).toEqual(
      ok({ method: 'brain:neighbourhood', args: ['e1', 1] }),
    )
    expect(parseBrainCli(['entity-memories', 'e1'])).toEqual(
      ok({ method: 'brain:entityMemories', args: ['e1', {}, null] }),
    )
    expect(parseBrainCli(['lane', 'show'])).toEqual(ok({ method: 'brain:laneShow', args: [] }))
    expect(parseBrainCli(['lane', 'send', 'Northwind', '3'])).toEqual(
      ok({ method: 'brain:laneSend', args: ['Northwind', 3] }),
    )
    expect(parseBrainCli(['lane', 'stop', '3', 'turn-1'])).toEqual(
      ok({ method: 'brain:laneStop', args: [3, 'turn-1'] }),
    )
  })

  it('asks for the GENERATION:REVISION stamp only on guarded writes and fills their revision from it', () => {
    expect(parseBrainCli(['queue', laneId, ...expected])).toEqual(
      ok({ method: 'brain:queue', args: [laneId], expected: { generation, revision: 7 } }),
    )
    expect(parseBrainCli(['never-read', laneId, 'off', ...expected])).toEqual(
      ok({
        method: 'brain:neverRead',
        args: [laneId, false],
        expected: { generation, revision: 7 },
      }),
    )
    expect(parseBrainCli(['undo', 'change-1', ...expected])).toEqual(
      ok({
        method: 'brain:tidyUndo',
        args: ['change-1', 7],
        expected: { generation, revision: 7 },
      }),
    )
    expect(parseBrainCli(['merge', 'e1', 'e2', ...expected])).toEqual(
      ok({ method: 'brain:merge', args: ['e1', 'e2', 7], expected: { generation, revision: 7 } }),
    )
    expect(parseBrainCli(['queue', laneId])).toEqual({
      ok: false,
      problem: expect.stringContaining('phosphor brain status --json'),
    })
    expect(parseBrainCli(['status', ...expected])).toEqual({
      ok: false,
      problem: expect.stringContaining('does not take --expected'),
    })
  })

  it('checks lane identity and values before connecting, without echoing them', () => {
    const refused = [
      ['queue', '/Harbor/Ledger', ...expected],
      ['queue', laneId, '--expected', 'nope'],
      ['find', 'Harbor', '0'],
      ['find', 'Harbor', '51'],
      ['changes', 'many'],
      ['never-read', laneId, 'maybe', ...expected],
      ['ask'],
      ['ask', 'one', 'two'],
      ['ask', 'Harbor', '--args', '["Harbor"]'],
      ['status', '--json', '--json'],
      ['status', '--bogus'],
      ['lane'],
      ['lane', 'fly'],
      ['search', 'Harbor'],
    ]
    for (const argv of refused) {
      const result = parseBrainCli(argv)
      expect(result, argv.join(' ')).toMatchObject({ ok: false })
      if (!result.ok) expect(result.problem).not.toMatch(/Ledger|Harbor/)
    }
  })

  it('keeps --args for structured arguments and checks a revision it carries against the stamp', () => {
    const prefs = { ...DEFAULT_BRAIN_PREFS, enabled: true }
    const stamped = { generation, revision: 7 }
    expect(parseBrainCli(['set-prefs', JSON.stringify(prefs), ...expected])).toEqual(
      ok({ method: 'brain:setPrefs', args: [prefs], expected: stamped }),
    )
    expect(parseBrainCli(['set-prefs', '{not json', ...expected])).toMatchObject({ ok: false })
    expect(parseBrainCli(['undo', ...expected, '--args', '["change-1",7]'])).toEqual(
      ok({
        method: 'brain:tidyUndo',
        args: ['change-1', 7],
        expected: { generation, revision: 7 },
      }),
    )
    expect(parseBrainCli(['undo', ...expected, '--args', '["change-1",6]'])).toMatchObject({
      ok: false,
    })
    expect(parseBrainCli(['lane', 'send', '--args', '["Northwind",3]'])).toEqual(
      ok({ method: 'brain:laneSend', args: ['Northwind', 3] }),
    )
  })
})

describe('brainHelp', () => {
  it('lists every private command with operands, the approval and this-Host target, never --host', () => {
    const overview = brainHelp()!
    expect(overview).toContain('phosphor brain queue <lane-id> --expected GENERATION:REVISION')
    expect(overview).toContain('phosphor brain ask <question>')
    expect(overview).toContain('phosphor brain lane send <message> <fence>')
    expect(overview).toMatch(/approve/i)
    expect(overview).toMatch(/this Host/)
    expect(overview).toContain('phosphor help brain.search')
    expect(overview).not.toContain('--host')
  })

  it('answers one command, and nothing for an unknown one', () => {
    expect(brainHelp('queue')).toMatch(
      /^Usage: phosphor brain queue <lane-id> --expected GENERATION:REVISION \[--json\]\n/,
    )
    expect(brainHelp('lane send')).toMatch(/^Usage: phosphor brain lane send <message> <fence>/)
    expect(brainHelp('set-prefs')).toMatch(
      /^Usage: phosphor brain set-prefs <settings-json> --expected/,
    )
    expect(brainHelp('split')).toContain('--args JSON_ARRAY')
    expect(brainHelp('fly')).toBeUndefined()
  })
})

describe('runCliBrain', () => {
  const context = {} as CliContext
  afterEach(() => {
    vi.useRealTimers()
  })

  function host(...replies: OpsRunResult[]) {
    const runBrain = vi.fn<ReturnType<typeof openLocalClient>['runBrain']>()
    for (const reply of replies) runBrain.mockResolvedValueOnce(reply)
    const close = vi.fn()
    vi.mocked(openLocalClient).mockReturnValue({ run: vi.fn(), runBrain, close })
    const out = { stdout: '', stderr: '' }
    const io = {
      stdout: (t: string) => void (out.stdout += t),
      stderr: (t: string) => void (out.stderr += t),
    }
    return { runBrain, close, out, io }
  }
  const confirm = (expiresAt: number): OpsRunResult => ({
    status: 'confirm',
    title: 'Allow brain:status once from the command line',
    message: 'Approve',
    confirmId,
    digest: 'd'.repeat(64),
    items: [],
    expiresAt,
  })
  const state = (value: string): OpsRunResult => ({
    status: 'ok',
    text: '',
    applies: 'now',
    data: { state: value },
  })

  it('prints help without opening the Host and refuses bad usage with 64', async () => {
    const { io, out } = host()
    vi.mocked(openLocalClient).mockClear()
    expect(await runCliBrain(['queue', '--help'], io, context)).toBe(0)
    expect(out.stdout).toMatch(/^Usage: phosphor brain queue/)
    expect(await runCliBrain(['status', '--host', 'Harbor'], io, context)).toBe(64)
    expect(out.stderr).toMatch(/this Host only/)
    expect(openLocalClient).not.toHaveBeenCalled()
  })

  it('redeems one approval, prints only a fixed line without --json and the projection with it', async () => {
    const data = { generation, revision: 7 }
    const reply: OpsRunResult = { status: 'ok', text: 'raw', applies: 'now', data }
    const text = host(confirm(Date.now() + 60_000), state('approved'), reply)
    expect(await runCliBrain(['status'], text.io, context)).toBe(0)
    expect(text.out.stdout).toBe(
      'Brain operation completed. Use --json for the authorized result.\n',
    )
    expect(text.out.stderr).toContain('c0ffee00')
    expect(text.runBrain.mock.calls).toEqual([
      [{ op: BRAIN_SURFACE, args: { method: 'brain:status', args: [] } }, false],
      [{ op: BRAIN_APPROVAL, args: { action: 'status', id: confirmId } }, false],
      [
        {
          op: BRAIN_SURFACE,
          args: { method: 'brain:status', args: [] },
          confirm: { confirmId, digest: 'd'.repeat(64) },
        },
        false,
      ],
    ])
    expect(text.close).toHaveBeenCalledOnce()
    const json = host(confirm(Date.now() + 60_000), state('approved'), reply)
    expect(await runCliBrain(['status', '--json'], json.io, context)).toBe(0)
    expect(json.out.stdout).toBe(`${JSON.stringify(data)}\n`)
  })

  it('closes the socket at expiry even when the status poll never returns', async () => {
    vi.useFakeTimers()
    const pending = host(confirm(Date.now() + 50))
    pending.runBrain.mockImplementation(() => new Promise(() => {}))
    const exit = runCliBrain(['status'], pending.io, context)
    await vi.advanceTimersByTimeAsync(50)
    expect(pending.close).toHaveBeenCalledOnce()
    expect(await exit).toBe(75)
    expect(pending.runBrain).toHaveBeenCalledTimes(2)
  })

  it('reports a denial and stops polling', async () => {
    const denied = host(confirm(Date.now() + 60_000), state('denied'))
    expect(await runCliBrain(['status'], denied.io, context)).toBe(1)
    expect(denied.out.stderr).toContain('The approver denied this Brain operation.')
    expect(denied.runBrain).toHaveBeenCalledTimes(2)
  })

  it('bounds the approval wait by the confirmation lifetime even when the Host offers longer', async () => {
    vi.useFakeTimers()
    const pending = host(confirm(Date.now() + 10 * OPS_LIMITS.confirmTtlMs))
    pending.runBrain.mockResolvedValue(state('pending'))
    const exit = runCliBrain(['status'], pending.io, context)
    await vi.advanceTimersByTimeAsync(OPS_LIMITS.confirmTtlMs + 5_000)
    expect(await exit).toBe(75)
    expect(pending.out.stderr).toContain('Approval timed out. No Brain operation ran.')
    expect(pending.runBrain.mock.calls.length).toBeLessThanOrEqual(
      2 + OPS_LIMITS.confirmTtlMs / 2000,
    )
  })
})
