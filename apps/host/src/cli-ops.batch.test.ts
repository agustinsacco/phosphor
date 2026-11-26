import { expect, it, vi } from 'vitest'
import type { OpsRunResult } from '@phosphor/shared/host-protocol-ops'
import type { CliContext } from './cli'
import { runCliOps } from './cli-ops'

const { run } = vi.hoisted(() => ({ run: vi.fn<() => Promise<OpsRunResult>>() }))
vi.mock('./local-client', () => ({ openLocalClient: () => ({ run, close: () => {} }) }))

it.each([0, 1, 2])('exits nonzero with %i failed hosts while keeping the JSON results', async (failed) => {
  const data = { summary: { total: 2, ok: 2 - failed, failed }, hosts: [] }
  const result: OpsRunResult = failed === 2
    ? { status: 'denied', code: 'unavailable', text: 'Batch failed', data }
    : { status: 'ok', applies: 'now', text: 'Batch answered', data }
  run.mockResolvedValueOnce(result)
  const stdout = vi.fn()
  const code = await runCliOps(
    ['artifact', 'list', '--host', 'a,b', '--json'],
    { stdout, stderr: vi.fn() },
    {} as CliContext,
    async () => 64,
  )
  expect(code).toBe(failed === 0 ? 0 : 1)
  expect(stdout).toHaveBeenCalledWith(`${JSON.stringify(result)}\n`)
})
