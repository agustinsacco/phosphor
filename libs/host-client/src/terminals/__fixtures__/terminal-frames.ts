import { sign, type KeyObject } from 'node:crypto'
import { helloProofMessage, type HostFrame, type ClientFrame } from '@phosphor/shared/host-protocol'
import type { HostHello } from '@phosphor/shared/remote-host'

type Ready = Extract<HostFrame, { type: 'ready' }>

/** The terminal fixture's signed ready frame, not a second protocol implementation. */
export function terminalReady(options: {
  hostId: string
  epoch: string
  capabilities: HostHello['capabilities']
  clientId: string
  challenge: string
  privateKey: KeyObject
}): Ready {
  return {
    type: 'ready',
    protocolVersion: 1,
    hello: {
      hostId: options.hostId,
      hostVersion: '1.0.0',
      protocolVersion: 1,
      runtimeEpoch: options.epoch,
      capabilities: options.capabilities,
    },
    proof: sign(
      null,
      Buffer.from(helloProofMessage(options.hostId, options.epoch, options.challenge)),
      options.privateKey,
    ).toString('base64url'),
    connectionId: '2222222222222222',
    grantExpiresAt: new Date(Date.now() + 300000).toISOString(),
    client: { id: options.clientId, label: 'Test' },
    capabilities: options.capabilities,
  }
}

export function terminalCommandReceipt(
  frame: Extract<ClientFrame, { type: 'command' }>,
  laneId: string,
  terminalId: string,
): Extract<HostFrame, { type: 'receipt' }> {
  return {
    type: 'receipt',
    receipt: {
      requestId: frame.requestId,
      status: 'done',
      laneId,
      data:
        frame.op.type === 'terminal.create' || frame.op.type === 'provider.login'
          ? { terminalId }
          : undefined,
    },
  }
}
