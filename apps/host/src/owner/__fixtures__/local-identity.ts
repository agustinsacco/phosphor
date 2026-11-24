import { generateKeyPairSync, randomUUID, sign, type KeyObject } from 'node:crypto'
import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import {
  HOST_SIDECARS,
  encodeLocalCredential,
  type LocalCredentialPayload,
} from '@phosphor/shared/host-local'
import { writeSidecar } from '../../config/sidecar'
import { exportKeyPem } from '../../control/identity-records'
import { publicIdentity } from '../../control/signer'

/** An Ed25519 pair with its raw public half as `owner-clients.json` and `local-identity.json` hold it. */
export function localKeyPair() {
  const { privateKey, publicKey } = generateKeyPairSync('ed25519')
  return { privateKey, publicKey, raw: publicIdentity(privateKey).publicKey }
}

/**
 * What `setup --local` leaves beside the config: the machine's local identity
 * and key, and one paired owner. Returns the owner's private key for signing.
 */
export async function writeLocalIdentity(configDirectory: string, uid: number | undefined) {
  const machine = localKeyPair()
  const owner = localKeyPair()
  const machineId = randomUUID()
  const ownerClient = { id: randomUUID(), label: 'Desktop' }
  await writeFile(join(configDirectory, HOST_SIDECARS.localKey), exportKeyPem(machine.privateKey), {
    mode: 0o600,
  })
  writeSidecar(
    configDirectory,
    HOST_SIDECARS.localIdentity,
    { version: 1, machineId, createdAt: new Date(0).toISOString(), publicKey: machine.raw },
    { uid, known: [] },
  )
  writeSidecar(
    configDirectory,
    HOST_SIDECARS.ownerClients,
    {
      version: 1,
      clients: [{ ...ownerClient, publicKey: owner.raw, addedAt: new Date(0).toISOString() }],
    },
    { uid, known: [] },
  )
  return { machineId, machine, owner, ownerClient }
}

/** A credential for the socket: signed by `key` for an owner, unsigned for a local caller. */
export function localCredential(
  payload: Omit<LocalCredentialPayload, 'v' | 'client' | 'iat'> & {
    client?: LocalCredentialPayload['client']
    iat?: number
  },
  key?: KeyObject,
): string {
  return encodeLocalCredential(
    {
      v: 1,
      client: payload.client ?? { id: randomUUID(), label: 'phosphor CLI' },
      iat: payload.iat ?? Math.floor(Date.now() / 1000),
      ...payload,
    },
    key ? (bytes) => sign(null, bytes, key) : undefined,
  )
}
