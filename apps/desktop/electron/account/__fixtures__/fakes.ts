import type { AccountUser, AuthSession } from '../gotrue'
import type { Cipher, Storage } from '../vault'

export const USER: AccountUser = {
  id: '6f1c2c1e-0000-4000-8000-000000000001',
  login: 'octo',
  name: 'Octo Cat',
  email: 'octo@example.com',
}

export function session(tag: string | number, expiresAt = Date.now() + 3_600_000): AuthSession {
  return { accessToken: `access-${tag}`, refreshToken: `refresh-${tag}`, expiresAt, user: USER }
}

/** Encrypts like fakeCipher, synchronously: for tests that build sealed files by hand. */
export const fakeSeal = (text: string): Buffer =>
  Buffer.from(`enc:${Buffer.from(text).toString('base64')}`)

/**
 * Reversible, visibly not plaintext, and counts decrypts (keychain reads).
 * Async like safeStorage's async API; set `gate` to hold every keychain call
 * until the test resolves it, the way an unanswered Keychain prompt does.
 */
export function fakeCipher(storage: Storage = { ok: true, kind: 'test' }) {
  const state: { storage: Storage; decrypts: number; gate: Promise<void> | null } = {
    storage,
    decrypts: 0,
    gate: null,
  }
  const wait = async (): Promise<void> => {
    if (state.gate) await state.gate
  }
  const cipher: Cipher = {
    storage: async () => {
      await wait()
      return state.storage
    },
    encrypt: async (text) => {
      await wait()
      return fakeSeal(text)
    },
    decrypt: async (data) => {
      state.decrypts++
      await wait()
      const raw = data.toString()
      if (!raw.startsWith('enc:')) throw new Error('not ours')
      return Buffer.from(raw.slice(4), 'base64').toString()
    },
  }
  return { cipher, state }
}

/** Lets queued promise callbacks run, the way the event loop does between ticks. */
export const flush = (): Promise<void> => new Promise((resolve) => setImmediate(resolve))

export interface Deferred<T> {
  promise: Promise<T>
  resolve(value: T): void
  reject(error: unknown): void
}

export function deferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

/**
 * A system browser that follows the authorize URL straight back to Phosphor's
 * loopback with `query`, or never comes back when `query` returns null.
 */
export function fakeBrowser(query: (authorize: URL) => string | null = () => 'code=valid-code-1') {
  const opened: URL[] = []
  const pages: Promise<{ status: number; body: string }>[] = []
  return {
    opened,
    pages,
    async open(raw: string): Promise<void> {
      const authorize = new URL(raw)
      opened.push(authorize)
      const back = query(authorize)
      if (back === null) return
      const target = `${authorize.searchParams.get('redirect_to')}?${back}`
      pages.push(fetch(target).then(async (r) => ({ status: r.status, body: await r.text() })))
    },
  }
}
