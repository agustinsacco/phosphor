import { expect, it, vi } from 'vitest'
import { machineHandlers } from './machine'
import type { DaemonHandlerDeps } from './index'

it('returns every provider and individual account outcome, but refuses a total failure', async () => {
  const usage = vi.fn(async () => [
    { id: 'a', label: 'First', status: 'ok', windows: [{ label: 'Current session', percentUsed: 25 }] },
    { id: 'b', label: 'Second', status: 'unavailable', reason: 'Usage probe timed out.' },
  ])
  const call = vi.fn(async () => ({ ok: true, data: { providers: [
    { id: 'pi-claude-cli', name: 'Claude CLI', status: 'ready' },
    { id: 'openai-codex', name: 'Codex', status: 'ready' },
  ] } }))
  const ctx = { signal: new AbortController().signal } as never
  const run = machineHandlers({ settingsOps: { settings: { usageAccounts: usage } }, lanes: { calls: { call } } } as unknown as DaemonHandlerDeps)['machine.usage']!
  expect(await run({}, ctx)).toMatchObject({ data: {
    accounts: [{ id: 'a', status: 'ok' }, { id: 'b', status: 'unavailable' }],
    providers: [{ id: 'pi-claude-cli' }, { id: 'openai-codex', usage: 'usage not available' }],
  } })
  usage.mockResolvedValueOnce([{ id: 'b', label: 'Second', status: 'unavailable', reason: 'Usage probe timed out.' }])
  call.mockResolvedValueOnce({ ok: true, data: { providers: [{ id: 'pi-claude-cli', name: 'Claude CLI', status: 'unknown' }] } })
  await expect(run({}, ctx)).rejects.toMatchObject({ code: 'unavailable', message: expect.stringContaining('timed out') })
})
