import { describe, expect, it, vi } from 'vitest'
import { LANE_WAIT_DEADLINE_MS } from '@phosphor/shared/ops'
import type { CommandResult } from './connection'
import { OPS_HOST_TOO_OLD, OPS_UNCONFIRMED, OPS_UNREADABLE, opsRun } from './ops'
import { REMOTE_UNAVAILABLE } from './lane-ops'

const request = { op: 'lane.list', args: {}, reason: 'Find the lane' }
const ok = { status: 'ok', text: 'Two lanes.', applies: 'now', data: { lanes: [] } } as const
type CallResult = Awaited<ReturnType<Parameters<typeof opsRun>[0]['call']>>

function connection(answers: { call?: CallResult; send?: CommandResult }) {
  return {
    call: vi.fn(async () => answers.call ?? { type: 'result', id: 'c', ok: true, data: ok }),
    send: vi.fn(async () => answers.send ?? { requestId: 'r', status: 'done', data: ok }),
  } as unknown as Parameters<typeof opsRun>[0] & {
    call: ReturnType<typeof vi.fn>
    send: ReturnType<typeof vi.fn>
  }
}

describe('opsRun', () => {
  it('sends a read as an ops.run call and a write as an unfenced ops.run command', async () => {
    const c = connection({})
    await expect(opsRun(c, request, { write: false })).resolves.toEqual(ok)
    expect(c.call).toHaveBeenCalledExactlyOnceWith('ops.run', request)
    expect(c.send).not.toHaveBeenCalled()
    await expect(opsRun(c, request, { write: true })).resolves.toEqual(ok)
    expect(c.send).toHaveBeenCalledExactlyOnceWith({ type: 'ops.run', ...request })
  })

  it('allows the remote lane wait to finish before the query transport expires', async () => {
    const c = connection({})
    const wait = { op: 'lane.wait', args: { ref: 'lane', timeout: 1800 } }
    await expect(opsRun(c, wait, { write: false })).resolves.toEqual(ok)
    expect(c.call).toHaveBeenCalledExactlyOnceWith('ops.run', wait, LANE_WAIT_DEADLINE_MS + 2000)
  })

  it('reads in-band denials and confirmations as they are', async () => {
    const denied = { status: 'denied', code: 'busy', text: 'A turn is running.' }
    const c = connection({ send: { requestId: 'r', status: 'done', data: denied } })
    await expect(opsRun(c, request, { write: true })).resolves.toEqual(denied)
  })

  // A 684cb3478 Host refuses the command form with a rejected `unsupported` receipt and
  // answers the call form from its method table, which has no ops.run: `unsupported`.
  it('reads an older Host as too old on both paths', async () => {
    const tooOld = { status: 'denied', code: 'unsupported', text: OPS_HOST_TOO_OLD }
    const command = connection({
      send: { requestId: 'r', status: 'rejected', code: 'unsupported' },
    })
    await expect(opsRun(command, request, { write: true })).resolves.toEqual(tooOld)
    const call = connection({
      call: {
        type: 'result',
        id: 'c',
        ok: false,
        error: { code: 'unsupported', message: 'unsupported' },
      },
    })
    await expect(opsRun(call, request, { write: false })).resolves.toEqual(tooOld)
  })

  it('throws on every other failure and never resends a write', async () => {
    const failed = connection({
      call: {
        type: 'result',
        id: 'c',
        ok: false,
        error: { code: 'internal', message: 'Query timed out.' },
      },
    })
    await expect(opsRun(failed, request, { write: false })).rejects.toThrow('Query timed out.')
    const unknown = connection({ send: { requestId: 'r', status: 'unknown' } })
    await expect(opsRun(unknown, request, { write: true })).rejects.toThrow(OPS_UNCONFIRMED)
    expect(unknown.send).toHaveBeenCalledOnce()
    const notSent = connection({
      send: { requestId: 'r', status: 'not-sent', reason: 'not-connected' },
    })
    await expect(opsRun(notSent, request, { write: true })).rejects.toThrow(REMOTE_UNAVAILABLE)
    const forbidden = connection({
      send: { requestId: 'r', status: 'rejected', code: 'forbidden' },
    })
    await expect(opsRun(forbidden, request, { write: true })).rejects.toThrow(REMOTE_UNAVAILABLE)
  })

  it('refuses a malformed request before sending and an unreadable answer after', async () => {
    const c = connection({ call: { type: 'result', id: 'c', ok: true, data: { status: 'maybe' } } })
    await expect(opsRun(c, { op: 'Not An Op', args: {} }, { write: false })).rejects.toThrow(
      'Invalid agent op request.',
    )
    expect(c.call).not.toHaveBeenCalled()
    await expect(opsRun(c, request, { write: false })).rejects.toThrow(OPS_UNREADABLE)
  })

  // Hosts before request `limit` parse ops.run with exact keys and answer `bad-request`
  // before running anything, so asking again without the page size is safe.
  it('asks an older Host again without --limit, and only then', async () => {
    const badRequest: CallResult = {
      type: 'result',
      id: 'c',
      ok: false,
      error: { code: 'bad-request', message: 'bad-request' },
    }
    const c = connection({})
    c.call.mockResolvedValueOnce(badRequest)
    await expect(opsRun(c, { ...request, limit: 10 }, { write: false })).resolves.toEqual(ok)
    expect(c.call).toHaveBeenNthCalledWith(1, 'ops.run', { ...request, limit: 10 })
    expect(c.call).toHaveBeenNthCalledWith(2, 'ops.run', request)
    const plain = connection({ call: badRequest })
    await expect(opsRun(plain, request, { write: false })).rejects.toThrow('bad-request')
    expect(plain.call).toHaveBeenCalledOnce()
  })
})
