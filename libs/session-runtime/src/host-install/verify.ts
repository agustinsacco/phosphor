import { createHash, createPublicKey, verify } from 'node:crypto'
import {
  HOST_RELEASE_KEYS,
  HOST_RELEASE_NAMESPACE,
  HOST_RELEASE_MANIFEST_MAX_BYTES,
  parseHostReleaseManifest,
  type HostReleaseKey,
  type HostReleaseManifest,
  type HostReleaseArtifact,
} from '@phosphor/shared/host-release'

const magic = Buffer.from('SSHSIG')
const string = (bytes: Buffer) => {
  const size = Buffer.alloc(4)
  size.writeUInt32BE(bytes.length)
  return Buffer.concat([size, bytes])
}
class Reader {
  private offset = 0
  constructor(private bytes: Buffer) {}
  number(): number {
    if (this.offset + 4 > this.bytes.length) throw new Error('Invalid release signature')
    const n = this.bytes.readUInt32BE(this.offset)
    this.offset += 4
    return n
  }
  string(): Buffer {
    const n = this.number()
    if (n > this.bytes.length - this.offset) throw new Error('Invalid release signature')
    const value = this.bytes.subarray(this.offset, this.offset + n)
    this.offset += n
    return value
  }
  end(): void {
    if (this.offset !== this.bytes.length) throw new Error('Invalid release signature')
  }
}
function publicBytes(blob: Buffer): Buffer {
  const reader = new Reader(blob)
  if (reader.string().toString() !== 'ssh-ed25519') throw new Error('Invalid release key')
  const key = reader.string()
  reader.end()
  if (key.length !== 32) throw new Error('Invalid release key')
  return key
}
/** Verify the exact manifest bytes before parsing any metadata. No subprocess or network. */
export function verifyReleaseManifest(
  manifest: Buffer,
  signature: string,
  keys: readonly HostReleaseKey[] = HOST_RELEASE_KEYS,
): HostReleaseManifest {
  try {
    if (
      manifest.length > HOST_RELEASE_MANIFEST_MAX_BYTES ||
      signature.length > 8192 ||
      keys.length > 16
    )
      throw new Error()
    const armor =
      /^-----BEGIN SSH SIGNATURE-----\n([A-Za-z0-9+/=\n]+)-----END SSH SIGNATURE-----\n?$/.exec(
        signature,
      )
    if (!armor?.[1]) throw new Error()
    const encoded = armor[1].replaceAll('\n', '')
    const bytes = Buffer.from(encoded, 'base64')
    if (bytes.toString('base64') !== encoded || !bytes.subarray(0, 6).equals(magic))
      throw new Error()
    const r = new Reader(bytes.subarray(6))
    if (r.number() !== 1) throw new Error()
    const blob = r.string()
    const keyBytes = publicBytes(blob)
    const namespace = r.string()
    const reserved = r.string()
    const hash = r.string()
    if (
      namespace.toString() !== HOST_RELEASE_NAMESPACE ||
      reserved.length !== 0 ||
      hash.toString() !== 'sha512'
    )
      throw new Error()
    const s = new Reader(r.string())
    if (s.string().toString() !== 'ssh-ed25519') throw new Error()
    const signed = s.string()
    s.end()
    r.end()
    if (
      signed.length !== 64 ||
      !keys.some((key) => {
        const fields = key.publicKey.split(' ')
        return (
          fields[0] === 'ssh-ed25519' &&
          fields[1] !== undefined &&
          Buffer.from(fields[1], 'base64').equals(blob)
        )
      })
    )
      throw new Error()
    const key = createPublicKey({
      key: Buffer.concat([Buffer.from('302a300506032b6570032100', 'hex'), keyBytes]),
      format: 'der',
      type: 'spki',
    })
    const message = Buffer.concat([
      magic,
      string(namespace),
      string(reserved),
      string(hash),
      string(createHash('sha512').update(manifest).digest()),
    ])
    if (!verify(null, message, key, signed)) throw new Error()
    const parsed = parseHostReleaseManifest(JSON.parse(manifest.toString('utf8')))
    if (!parsed) throw new Error()
    return parsed
  } catch {
    throw new Error('Invalid release manifest or signature')
  }
}
export function verifyReleaseArtifact(bytes: Buffer, artifact: HostReleaseArtifact): void {
  if (
    bytes.length !== artifact.bytes ||
    createHash('sha256').update(bytes).digest('hex') !== artifact.sha256
  )
    throw new Error('Invalid release artifact')
}
