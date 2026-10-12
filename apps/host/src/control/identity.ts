import { constants } from 'node:fs'
import { lstat, mkdir, open, opendir, rename, unlink } from 'node:fs/promises'
import { createPrivateKey, randomUUID, type KeyObject } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { isIsoTime, isUuid, parseHostSelfResponse } from '@phosphor/shared/control-api'
import { isControlUrl } from './url'
import { publicIdentity } from './signer'

export interface HostIdentity {
  version: 1
  controlUrl: string
  hostId: string
  label: string
  ownerLogin: string | null
  savedAt: string
}

export class IdentityFailure extends Error {
  constructor(
    message: string,
    readonly incomplete?: HostIdentity,
  ) {
    super(message)
  }
}
const unsafe = () =>
  new IdentityFailure(
    'Unsafe identity storage. Use files owned by you, no symlinks, chmod 600 host-key.*.pem host.json and chmod 700 identity.',
  )
const missing = (error: unknown) =>
  error instanceof Error && 'code' in error && error.code === 'ENOENT'

export function identityDirectory(configPath: string): string {
  return join(dirname(resolve(configPath)), 'identity')
}

function parseIdentity(value: unknown): HostIdentity {
  const invalid = () =>
    new IdentityFailure('Invalid identity. Run phosphor logout --local, then phosphor login.')
  if (
    value === null ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    !('version' in value) ||
    value.version !== 1 ||
    !('controlUrl' in value) ||
    !isControlUrl(value.controlUrl) ||
    !('savedAt' in value) ||
    !isIsoTime(value.savedAt) ||
    !('ownerLogin' in value)
  )
    throw invalid()
  const parsed = parseHostSelfResponse({
    ...value,
    owner: { login: value.ownerLogin },
    enrolledAt: value.savedAt,
    lastSeenAt: null,
  })
  if (!parsed.ok) throw invalid()
  return {
    version: 1,
    controlUrl: value.controlUrl,
    hostId: parsed.value.hostId,
    label: parsed.value.label,
    ownerLogin: parsed.value.owner.login,
    savedAt: value.savedAt,
  }
}

/** host.json commits the pair. An interrupted save never replaces the old key. */
export function createIdentityStore(
  directory: string,
  uid: number | undefined,
  ports = { rename },
) {
  async function checkDirectory() {
    const info = await lstat(directory)
    if (
      !info.isDirectory() ||
      info.isSymbolicLink() ||
      uid === undefined ||
      info.uid !== uid ||
      info.mode & 0o077
    )
      throw unsafe()
    return info
  }
  async function read(name: string) {
    const path = join(directory, name)
    const info = await lstat(path)
    if (!info.isFile() || info.isSymbolicLink() || info.uid !== uid || info.mode & 0o077)
      throw unsafe()
    const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
    try {
      const actual = await file.stat()
      if (!actual.isFile() || actual.uid !== uid || actual.mode & 0o077 || actual.size > 4096)
        throw unsafe()
      const bytes = Buffer.alloc(4097)
      const { bytesRead } = await file.read(bytes, 0, bytes.length, 0)
      if (bytesRead > 4096) throw unsafe()
      return bytes.subarray(0, bytesRead).toString('utf8')
    } finally {
      await file.close()
    }
  }
  async function atomic(name: string, text: string | Buffer, signal?: AbortSignal) {
    const temp = join(directory, `.host-${randomUUID()}.tmp`)
    try {
      const file = await open(temp, 'wx', 0o600)
      try {
        await file.writeFile(text)
        await file.sync()
      } finally {
        await file.close()
      }
      signal?.throwIfAborted()
      await ports.rename(temp, join(directory, name))
    } finally {
      await unlink(temp).catch((error: unknown) => {
        if (!missing(error)) throw unsafe()
      })
    }
  }
  async function cleanKeys(keep?: string) {
    const dir = await opendir(directory)
    let count = 0
    for await (const entry of dir) {
      if (++count > 1000)
        throw new IdentityFailure('Too many identity files. Remove unused host-key files.')
      const id = /^host-key\.(.+)\.pem$/.exec(entry.name)?.[1]
      if (isUuid(id) && entry.name !== keep) await unlink(join(directory, entry.name))
    }
  }
  return {
    async load(): Promise<{ identity: HostIdentity; key: KeyObject } | null> {
      let before
      try {
        before = await checkDirectory()
      } catch (error) {
        if (missing(error)) return null
        throw unsafe()
      }
      let text: string
      try {
        text = await read('host.json')
      } catch (error) {
        if (missing(error)) return null
        throw unsafe()
      }
      let identity: HostIdentity
      try {
        const value: unknown = JSON.parse(text)
        identity = parseIdentity(value)
      } catch {
        throw new IdentityFailure(
          'Invalid identity. Run phosphor logout --local, then phosphor login.',
        )
      }
      try {
        const key = createPrivateKey(await read(`host-key.${identity.hostId}.pem`))
        publicIdentity(key)
        const after = await checkDirectory()
        if (before.ino !== after.ino || before.dev !== after.dev) throw unsafe()
        return { identity, key }
      } catch {
        throw new IdentityFailure(
          'Identity incomplete. Use an owned regular key, no symlink, chmod 600 host-key.*.pem; run phosphor login.',
          identity,
        )
      }
    },
    async save(identity: HostIdentity, key: KeyObject, signal?: AbortSignal) {
      const parsed = parseIdentity(identity)
      publicIdentity(key)
      if (uid === undefined) throw unsafe()
      signal?.throwIfAborted()
      const keyName = `host-key.${parsed.hostId}.pem`
      let written = false
      let committed = false
      try {
        await mkdir(directory, { recursive: true, mode: 0o700 })
        await checkDirectory()
        // Never overwrite a key an earlier commit can still reference.
        try {
          await lstat(join(directory, keyName))
          throw unsafe()
        } catch (error) {
          if (!missing(error)) throw error
        }
        await atomic(keyName, key.export({ type: 'pkcs8', format: 'pem' }), signal)
        written = true
        await atomic('host.json', JSON.stringify(parsed) + '\n', signal)
        committed = true
        await cleanKeys(keyName)
      } catch (error) {
        if (written && !committed && signal?.aborted) {
          await unlink(join(directory, keyName)).catch((cleanupError: unknown) => {
            if (!missing(cleanupError)) throw unsafe()
          })
        }
        if (error instanceof IdentityFailure) throw error
        throw new IdentityFailure('Identity save failed. Run phosphor status before retrying.')
      }
    },
    async remove() {
      try {
        await checkDirectory()
      } catch (error) {
        if (missing(error)) return
        throw unsafe()
      }
      await unlink(join(directory, 'host.json')).catch((error: unknown) => {
        if (!missing(error)) throw unsafe()
      })
      await cleanKeys()
    },
  }
}
export type IdentityStore = ReturnType<typeof createIdentityStore>
