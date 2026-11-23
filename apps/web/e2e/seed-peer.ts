import { expect } from '@playwright/test'
import { randomBytes, randomUUID } from 'node:crypto'
import { once } from 'node:events'
import { WebSocket } from 'ws'
import type { Config } from '../../control/src/config'
import { HOST_CAPABILITIES } from '@phosphor/shared/remote-host'
import {
  parseHostFrame,
  type ClientFrame,
  type HostFrame,
  type LaneOp,
} from '@phosphor/shared/host-protocol'
import { parseOpsRunResult } from '@phosphor/shared/host-protocol-ops'

interface SeedPorts {
  hostPort: number
  keys: NonNullable<Config['grantKeys']>
  controlOrigin: string
  owner: string
  sid: string
  hostId: string
  cleanups: (() => Promise<unknown>)[]
}
/** Only disposable, signed fixture principals; machine asks use the Host's real confirm store. */
export async function seedPeer(
  { hostPort, keys, controlOrigin, owner, sid, hostId, cleanups }: SeedPorts,
  machine?: string,
) {
  const peer = new WebSocket(`ws://127.0.0.1:${hostPort}/v1/stream`)
  cleanups.push(async () => peer.terminate())
  const frames: HostFrame[] = []
  peer.on('message', (raw) => {
    const frame = parseHostFrame(raw.toString())
    if (frame.ok) frames.push(frame.value)
  })
  await once(peer, 'open')
  const send = (frame: ClientFrame) => peer.send(JSON.stringify(frame))
  const iat = Math.floor(Date.now() / 1000)
  send({
    type: 'auth',
    challenge: 'b'.repeat(64),
    trace: '0123456789abcdef',
    grant: keys.sign({
      v: 1,
      iss: controlOrigin,
      kid: keys.kid,
      sub: owner,
      sid,
      hostId,
      epoch: 1,
      client: { id: randomUUID(), label: machine ? 'Synthetic requester' : 'Synthetic seeder' },
      ...(machine
        ? { caps: [], origin: 'machine' as const, machine }
        : { caps: HOST_CAPABILITIES }),
      iat,
      exp: iat + 300,
      jti: randomBytes(8).toString('hex'),
    }),
  })
  await expect.poll(() => frames.some((f) => f.type === 'ready')).toBe(true)
  const command = async (op: LaneOp, laneId?: string, fence?: number) => {
    const requestId = randomUUID()
    send({
      type: 'command',
      requestId,
      op,
      ...(laneId ? { laneId } : {}),
      ...(fence === undefined ? {} : { fence }),
    })
    await expect
      .poll(() =>
        frames.some(
          (f) =>
            f.type === 'receipt' &&
            f.receipt.requestId === requestId &&
            f.receipt.status !== 'pending',
        ),
      )
      .toBe(true)
    const result = frames.findLast((f) => f.type === 'receipt' && f.receipt.requestId === requestId)
    if (result?.type !== 'receipt' || result.receipt.status !== 'done')
      throw new Error('Host seed command failed')
    return result.receipt
  }
  return { frames, send, command }
}

export async function askToPurge(ports: SeedPorts, id: string, reason: string) {
  const peer = await seedPeer(ports, randomUUID())
  const receipt = await peer.command({
    type: 'ops.run',
    op: 'archive.purge',
    args: { ids: [id] },
    reason,
  })
  const result = parseOpsRunResult(receipt.data)
  if (result?.status !== 'confirm')
    throw Error(`Expected a pending request, got ${result?.status}.`)
  return result.confirmId
}
