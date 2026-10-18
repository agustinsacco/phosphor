import {
  HOST_LIMITS,
  helloProofMessage,
  parseHostFrame,
  utf8Length,
} from '@phosphor/shared/host-protocol'
import { UnsupportedIdentityCrypto, type IdentityCrypto } from './crypto'

/** One proof per transport; bounded receive barrier while WebCrypto is pending. */
export function createHandshake(ports: {
  hostId: string
  key: string
  challenge: string
  identity: IdentityCrypto
  current: () => boolean
  receive: (text: string) => void
  refuse: (unsupported: boolean) => void
}) {
  let state: 'initial' | 'verifying' | 'ready' | 'closed' = 'initial'
  const queued: string[] = []
  let bytes = 0
  function refuse(error?: unknown) {
    if (state === 'closed') return
    state = 'closed'
    queued.length = 0
    if (ports.current()) ports.refuse(error instanceof UnsupportedIdentityCrypto)
  }
  function verified(text: string, valid: boolean) {
    if (state !== 'verifying' || !ports.current()) return
    if (!valid) {
      refuse()
      return
    }
    state = 'ready'
    ports.receive(text)
    for (const frame of queued) {
      if (!ports.current()) break
      ports.receive(frame)
    }
    queued.length = 0
    bytes = 0
  }
  return {
    receive(text: string) {
      if (!ports.current() || state === 'closed') return
      if (state === 'ready') {
        ports.receive(text)
        return
      }
      const parsed = parseHostFrame(text)
      if (!parsed.ok) {
        refuse()
        return
      }
      if (parsed.value.type === 'error') {
        // Host auth refusals precede their close frame. Keep data blocked, but
        // let the close code drive grant invalidation, backoff or permanent refusal.
        state = 'closed'
        queued.length = 0
        bytes = 0
        return
      }
      if (state === 'verifying') {
        bytes += utf8Length(text)
        if (
          parsed.value.type === 'ready' ||
          queued.length >= HOST_LIMITS.pendingEvents ||
          bytes > HOST_LIMITS.outboundFrameBytes
        ) {
          refuse()
          return
        }
        queued.push(text)
        return
      }
      const frame = parsed.value
      if (frame.type !== 'ready' || frame.hello.hostId !== ports.hostId) {
        refuse()
        return
      }
      state = 'verifying'
      try {
        const result = ports.identity.verify(
          ports.key,
          new TextEncoder().encode(
            helloProofMessage(frame.hello.hostId, frame.hello.runtimeEpoch, ports.challenge),
          ),
          frame.proof,
        )
        if (typeof result === 'boolean') verified(text, result)
        else void result.then((valid) => verified(text, valid), refuse)
      } catch (error) {
        refuse(error)
      }
    },
  }
}
