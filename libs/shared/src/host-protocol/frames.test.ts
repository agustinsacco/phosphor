import { describe, expectTypeOf, it } from 'vitest'
import type * as facade from '../host-protocol'
import type { TerminalFrame, TerminalInput, TerminalSubscribe } from '../host-protocol-terminals'
import type { ClientFrame, ClientFrameParse, FrameSocket, HostFrame } from './frames'

type Of<F extends { type: string }, T extends F['type']> = Extract<F, { type: T }>

// frames.ts holds declarations only, so these checks run when tsc checks this file.

describe('host-protocol frame declarations', () => {
  it('cover every client frame type and subscribe topic', () => {
    expectTypeOf<ClientFrame['type']>().toEqualTypeOf<
      | 'auth'
      | 'subscribe'
      | 'unsubscribe'
      | 'command'
      | 'receipt-status'
      | 'call'
      | 'ping'
      | 'terminal.input'
    >()
    expectTypeOf<Of<ClientFrame, 'subscribe'>['topic']>().toEqualTypeOf<
      'lanes' | 'lane' | 'terminal'
    >()
    expectTypeOf<Of<ClientFrame, 'terminal.input'>>().toEqualTypeOf<TerminalInput>()
    expectTypeOf<Extract<ClientFrame, { topic: 'terminal' }>>().toEqualTypeOf<TerminalSubscribe>()
  })

  it('cover every Host frame type, result outcome and subscribe failure', () => {
    expectTypeOf<HostFrame['type']>().toEqualTypeOf<
      | TerminalFrame['type']
      | 'ready'
      | 'auth-renewed'
      | 'lanes'
      | 'lanes-delta'
      | 'routines-changed'
      | 'attention'
      | 'snapshot'
      | 'event'
      | 'subscribe-failed'
      | 'receipt'
      | 'result'
      | 'error'
      | 'pong'
    >()
    expectTypeOf<TerminalFrame['type']>().toEqualTypeOf<
      'terminal.ack' | 'terminal.output' | 'terminal.reset' | 'terminal.exit'
    >()
    expectTypeOf<Of<HostFrame, 'result'>['ok']>().toEqualTypeOf<boolean>()
    expectTypeOf<Of<HostFrame, 'subscribe-failed'>['code']>().toEqualTypeOf<
      'unknown-lane' | 'too-many' | 'forbidden' | 'bad-request' | 'too-large'
    >()
    expectTypeOf<Of<HostFrame, 'ready'>['protocolVersion']>().toEqualTypeOf<1>()
  })

  it('keep the socket surface and the client parse result envelope', () => {
    expectTypeOf<FrameSocket['send']>().toEqualTypeOf<(text: string) => void>()
    expectTypeOf<FrameSocket['close']>().toEqualTypeOf<(code: number, reason: string) => void>()
    expectTypeOf<FrameSocket['onMessage']>().toEqualTypeOf<(cb: (text: string) => void) => void>()
    expectTypeOf<FrameSocket['onClose']>().toEqualTypeOf<
      (cb: (code: number, reason: string) => void) => void
    >()
    expectTypeOf<FrameSocket['isOpen']>().toEqualTypeOf<() => boolean>()
    expectTypeOf<FrameSocket['bufferedBytes']>().toEqualTypeOf<() => number>()
    expectTypeOf<Extract<ClientFrameParse, { ok: true }>['frame']>().toEqualTypeOf<ClientFrame>()
    expectTypeOf<Extract<ClientFrameParse, { ok: false }>['reply']>().toEqualTypeOf<
      | { kind: 'receipt'; requestId: string; code: 'unsupported' | 'bad-request' }
      | { kind: 'result'; id: string; code: 'bad-request' }
      | undefined
    >()
  })

  it('reach clients unchanged through the public entry', () => {
    expectTypeOf<facade.ClientFrame>().toEqualTypeOf<ClientFrame>()
    expectTypeOf<facade.HostFrame>().toEqualTypeOf<HostFrame>()
    expectTypeOf<facade.FrameSocket>().toEqualTypeOf<FrameSocket>()
    expectTypeOf<facade.ClientFrameParse>().toEqualTypeOf<ClientFrameParse>()
  })
})
