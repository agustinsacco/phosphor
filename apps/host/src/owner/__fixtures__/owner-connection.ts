import { expect, vi } from 'vitest'
import { socketHello, socketStream } from '../../api/__fixtures__/local-client'
import { localCredential, type writeLocalIdentity } from './local-identity'

type Identity = Awaited<ReturnType<typeof writeLocalIdentity>>
type Stream = ReturnType<typeof socketStream>

/** Desktop on the socket: a fresh nonce, a signed owner credential, then ready. */
export async function ownerConnection(path: string, local: Identity, now: () => number) {
  const { body } = await socketHello(path)
  const stream = socketStream(path)
  await stream.opened
  const nonce = (body as { nonce: string }).nonce
  const grant = localCredential(
    {
      kind: 'owner',
      machineId: local.machineId,
      client: local.ownerClient,
      nonce,
      iat: Math.floor(now() / 1000),
    },
    local.owner.privateKey,
  )
  stream.send({ type: 'auth', grant, challenge: 'c'.repeat(64) })
  await vi.waitFor(() => expect(stream.frames[0]).toMatchObject({ type: 'ready' }))
  return stream
}

/** The result frame for call `id`, once it arrives. */
export async function result(stream: Stream, id: string) {
  await vi.waitFor(
    () => expect(stream.frames.some((f) => f.type === 'result' && f.id === id)).toBe(true),
    { timeout: 5000 },
  )
  return stream.frames.find((f) => f.type === 'result' && f.id === id)
}
