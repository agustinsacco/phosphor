import { rename } from 'node:fs/promises'
import { createPrivateKey, type KeyObject } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import {
  checkIdentityDirectory,
  cleanHostKeys,
  ensureIdentityDirectory,
  existingIdentityDirectory,
  identityEntryExists,
  isMissing,
  readIdentityFile,
  removeIdentityFile,
  writeIdentityFileAtomic,
} from './identity-files'
import {
  assertReusableOrphan,
  discardsUncommittedKey,
  exportKeyPem,
  incompleteIdentity,
  keyFileName,
  parseIdentity,
  parseIdentityText,
  parsePending,
  pendingKeyMatches,
  saveFailure,
  unsafeIdentity,
} from './identity-records'
import type {
  HostIdentity,
  IdentityLocation,
  IdentityPorts,
  LoadedIdentity,
  LoadedPending,
  PendingEnrollment,
} from './identity-types'
import { publicIdentity } from './signer'

export type { HostIdentity, PendingEnrollment } from './identity-types'
export { IdentityFailure } from './identity-records'
export {
  checkIdentityDirectory,
  readIdentityFile,
  readIdentityFileSnapshot,
} from './identity-files'

export function identityDirectory(configPath: string): string {
  return join(dirname(resolve(configPath)), 'identity')
}

async function loadPending({ directory, uid }: IdentityLocation): Promise<LoadedPending | null> {
  try {
    await checkIdentityDirectory(directory, uid)
    const value: unknown = JSON.parse(await readIdentityFile(directory, uid, 'pending.json'))
    const enrollment = parsePending(value)
    const key = createPrivateKey(await readIdentityFile(directory, uid, 'pending-key.pem'))
    return pendingKeyMatches(enrollment, key) ? { enrollment, key } : null
  } catch {
    // Invalid pending state is not an identity. Login discards it under the lock.
    return null
  }
}

async function savePending(
  location: IdentityLocation,
  enrollment: PendingEnrollment,
  key: KeyObject,
  signal?: AbortSignal,
) {
  const parsed = parsePending(enrollment)
  if (!pendingKeyMatches(parsed, key)) throw unsafeIdentity()
  await ensureIdentityDirectory(location.directory, location.uid)
  await writeIdentityFileAtomic(location, 'pending-key.pem', exportKeyPem(key), signal)
  await writeIdentityFileAtomic(location, 'pending.json', JSON.stringify(parsed) + '\n', signal)
}

async function removePending({ directory, uid }: IdentityLocation) {
  if (!(await existingIdentityDirectory(directory, uid))) return
  for (const name of ['pending.json', 'pending-key.pem']) await removeIdentityFile(directory, name)
}

async function loadIdentity({ directory, uid }: IdentityLocation): Promise<LoadedIdentity | null> {
  const before = await existingIdentityDirectory(directory, uid)
  if (!before) return null
  let text: string
  try {
    text = await readIdentityFile(directory, uid, 'host.json')
  } catch (error) {
    if (isMissing(error)) return null
    throw unsafeIdentity()
  }
  const identity = parseIdentityText(text)
  try {
    const key = createPrivateKey(
      await readIdentityFile(directory, uid, keyFileName(identity.hostId)),
    )
    publicIdentity(key)
    const after = await checkIdentityDirectory(directory, uid)
    if (before.ino !== after.ino || before.dev !== after.dev) throw unsafeIdentity()
    return { identity, key }
  } catch {
    throw incompleteIdentity(identity)
  }
}

/** Write the key under `keyName`, or reuse an identical uncommitted orphan. True when written. */
async function publishKey(
  location: IdentityLocation,
  keyName: string,
  key: KeyObject,
  signal?: AbortSignal,
): Promise<boolean> {
  const { directory, uid } = location
  if (!(await identityEntryExists(join(directory, keyName)))) {
    await writeIdentityFileAtomic(location, keyName, exportKeyPem(key), signal)
    return true
  }
  const stored = await readIdentityFile(directory, uid, keyName)
  await assertReusableOrphan(stored, exportKeyPem(key), () =>
    identityEntryExists(join(directory, 'host.json')),
  )
  return false
}

/** host.json commits the pair. An interrupted save never replaces the old key. */
async function saveIdentity(
  location: IdentityLocation,
  identity: HostIdentity,
  key: KeyObject,
  signal?: AbortSignal,
) {
  const { directory, uid } = location
  const parsed = parseIdentity(identity)
  publicIdentity(key)
  if (uid === undefined) throw unsafeIdentity()
  signal?.throwIfAborted()
  const keyName = keyFileName(parsed.hostId)
  let written = false
  let committed = false
  try {
    await ensureIdentityDirectory(directory, uid)
    written = await publishKey(location, keyName, key, signal)
    await writeIdentityFileAtomic(location, 'host.json', JSON.stringify(parsed) + '\n', signal)
    committed = true
    await cleanHostKeys(directory, keyName)
  } catch (error) {
    if (discardsUncommittedKey({ written, committed, aborted: signal?.aborted === true }))
      await removeIdentityFile(directory, keyName)
    throw saveFailure(error)
  }
}

/** Remove host.json and every host key. With `expectedHostId`, false if another host is committed. */
async function removeIdentity(
  { directory, uid }: IdentityLocation,
  expectedHostId?: string,
): Promise<false | undefined> {
  if (!(await existingIdentityDirectory(directory, uid))) return
  if (expectedHostId !== undefined) {
    try {
      const current: unknown = JSON.parse(await readIdentityFile(directory, uid, 'host.json'))
      if (parseIdentity(current).hostId !== expectedHostId) return false
    } catch (error) {
      if (!isMissing(error)) throw error
    }
  }
  await removeIdentityFile(directory, 'host.json')
  await cleanHostKeys(directory)
}

/** host.json commits the pair. An interrupted save never replaces the old key. */
export function createIdentityStore(
  directory: string,
  uid: number | undefined,
  ports: IdentityPorts = { rename },
) {
  const location: IdentityLocation = { directory, uid, ports }
  return {
    loadPending: () => loadPending(location),
    savePending: (enrollment: PendingEnrollment, key: KeyObject, signal?: AbortSignal) =>
      savePending(location, enrollment, key, signal),
    removePending: () => removePending(location),
    load: () => loadIdentity(location),
    save: (identity: HostIdentity, key: KeyObject, signal?: AbortSignal) =>
      saveIdentity(location, identity, key, signal),
    remove: (expectedHostId?: string) => removeIdentity(location, expectedHostId),
  }
}
export type IdentityStore = ReturnType<typeof createIdentityStore>
