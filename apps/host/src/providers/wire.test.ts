import { randomUUID } from 'node:crypto'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { openStore } from '../lanes/store'
import { createLaneCommands, type LaneCommandClient } from '../lanes/commands'
import type { Receipt } from '@phosphor/shared/host-protocol'
import type { HostCapability } from '@phosphor/shared/remote-host'

it('uses owner-only receipts, suppresses duplicate logins, and rechecks both queued capabilities', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'provider-wire-'))
  const store = await openStore(dir, process.getuid?.(), { now: Date.now })
  const receipts: { client: string; receipt: Receipt }[] = []
  let release = () => {}
  let held = Promise.resolve()
  const execute = vi.fn(async () => {
    await held
    return { terminalId: randomUUID() }
  })
  const log = vi.fn()
  const commands = createLaneCommands({
    store,
    providerLogins: { execute, active: () => false },
    sessions: { start: vi.fn(), attach: vi.fn(), stop: vi.fn() },
    runtime: { command: vi.fn(), extensionUiResponse: vi.fn() },
    resumeLane: vi.fn(),
    stopLane: vi.fn(),
    sessionFor: () => null,
    openDialogs: () => [],
    summaryFor: () => null,
    publish() {},
    deliver: (client, receipt) => receipts.push({ client, receipt }),
    now: Date.now,
    log,
  })
  const client: LaneCommandClient = {
    id: randomUUID(),
    label: 'Test',
    caps: ['terminal', 'sessions.control'],
  }
  const frame = () => ({
    type: 'command' as const,
    requestId: randomUUID(),
    op: { type: 'provider.login' as const, provider: 'xai' },
  })
  try {
    const first = frame()
    await commands.submit(client, first)
    await commands.submit(client, first)
    expect(execute).toHaveBeenCalledOnce()
    expect(receipts.at(-1)?.receipt.status).toBe('done')
    commands.status(randomUUID(), first.requestId)
    expect(receipts.at(-1)?.receipt.status).toBe('unknown')
    for (const lost of ['terminal', 'sessions.control']) {
      const caps = client.caps.filter((cap) => cap !== lost)
      const refused = frame()
      await commands.submit({ ...client, caps }, refused)
      expect(store.getReceipt(refused.requestId, client.id)).toBeNull()
      expect(receipts.at(-1)?.receipt).toMatchObject({ status: 'rejected', code: 'forbidden' })
      held = new Promise<void>((resolve) => {
        release = resolve
      })
      const blocker = commands.submit(client, frame())
      let live: readonly HostCapability[] = client.caps
      const queued = frame()
      const pending = commands.submit({ ...client, currentCaps: () => live }, queued)
      live = caps
      release()
      await Promise.all([blocker, pending])
      expect(store.getReceipt(queued.requestId, client.id)).toMatchObject({
        status: 'rejected',
        code: 'forbidden',
      })
    }
    for (const extra of [{ fence: 1 }, { laneId: randomUUID() }]) {
      for (const op of [frame().op, { type: 'terminal.kill' as const, terminalId: randomUUID() }]) {
        if ('laneId' in extra && op.type === 'terminal.kill') continue
        await commands.submit(client, { ...frame(), ...extra, op })
        expect(receipts.at(-1)?.receipt).toMatchObject({ status: 'rejected', code: 'bad-request' })
      }
    }
    // Admission, execution and dispatch each read current authorization. Lose it at dispatch.
    let reads = 0
    await commands.submit(
      { ...client, currentCaps: () => (++reads < 3 ? client.caps : []) },
      frame(),
    )
    expect(receipts.at(-1)?.receipt.status).toBe('unknown')
    expect(reads).toBe(3)
    expect(execute).toHaveBeenCalledTimes(3)
    expect(JSON.stringify(log.mock.calls)).not.toContain('xai')
  } finally {
    await commands.close()
    store.close()
    rmSync(dir, { recursive: true, force: true })
  }
})
