import { describe, expect, expectTypeOf, it } from 'vitest'
import * as facade from '../host-protocol'
import { HOST_PROTOCOL_VERSION as REMOTE_HOST_VERSION } from '../remote-host'
import {
  HOST_API_PORT,
  HOST_API_ROUTES,
  HOST_CLOSE,
  HOST_LIMITS,
  HOST_PROTOCOL_VERSION,
  helloProofMessage,
  type HostCloseCode,
} from './constants'

describe('host-protocol constants', () => {
  it('keeps every upper bound exactly', () => {
    expect(HOST_LIMITS).toStrictEqual({
      inboundFrameBytes: 8_388_608,
      outboundFrameBytes: 16_777_216,
      authTimeoutMs: 10_000,
      grantTtlSec: 300,
      renewBeforeSec: 60,
      pingIntervalMs: 20_000,
      idleCloseMs: 60_000,
      subscriptionsPerConnection: 64,
      connectionsPerClient: 4,
      pendingCommandsPerConnection: 32,
      commandAnswerMs: 30_000,
      replayEvents: 2000,
      replayBytes: 8_388_608,
      sendQueueBytes: 33_554_432,
      pendingEvents: 4000,
      uiStatusKeys: 64,
      uiWidgetKeys: 32,
      receiptsKept: 10_000,
      receiptTtlMs: 86_400_000,
      receiptDataBytes: 262_144,
      lanesPerHost: 1000,
      repositoriesPerHost: 64,
      attentionReplay: 200,
      labelChars: 80,
      messageChars: 2000,
      idChars: 64,
    })
  })

  it('keeps the close codes, port, routes and protocol version', () => {
    expect(HOST_CLOSE).toStrictEqual({
      goingAway: 1001,
      badFrame: 4400,
      unauthenticated: 4401,
      forbidden: 4403,
      unsupportedProtocol: 4409,
      tooMany: 4429,
    })
    expectTypeOf<HostCloseCode>().toEqualTypeOf<1001 | 4400 | 4401 | 4403 | 4409 | 4429>()
    expect(HOST_API_PORT).toBe(47615)
    expect(HOST_API_ROUTES).toStrictEqual({ hello: '/v1/hello', stream: '/v1/stream' })
    expect(HOST_PROTOCOL_VERSION).toBe(REMOTE_HOST_VERSION)
  })

  it('builds the byte-exact hello proof message without normalizing its inputs', () => {
    const message = helloProofMessage('h', 'e', 'c')
    expect(Buffer.from(message, 'utf8').toString('hex')).toBe(
      '70686f7370686f722d686f73742d68656c6c6f2f76310a680a650a63',
    )
    expect(helloProofMessage(' H ', 'é', '')).toBe('phosphor-host-hello/v1\n H \né\n')
  })

  it('is what the public entry exports', () => {
    expect(facade.HOST_LIMITS).toBe(HOST_LIMITS)
    expect(facade.HOST_CLOSE).toBe(HOST_CLOSE)
    expect(facade.HOST_API_ROUTES).toBe(HOST_API_ROUTES)
    expect(facade.HOST_API_PORT).toBe(HOST_API_PORT)
    expect(facade.HOST_PROTOCOL_VERSION).toBe(HOST_PROTOCOL_VERSION)
    expect(facade.helloProofMessage).toBe(helloProofMessage)
    expectTypeOf<facade.HostCloseCode>().toEqualTypeOf<HostCloseCode>()
  })
})
