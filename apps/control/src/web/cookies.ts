import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { Context } from 'hono'
import type { Env } from '../http'
import { ControlFailure } from '../http'
import type { WebConfig } from './config'

type Purpose = 'session' | 'transaction'
/** A session handle: 32 random bytes, base64url. */
const HANDLE = /^[\w-]{43}$/

/**
 * The session cookie is an opaque handle to a database row, so it never changes after
 * sign-in. The short-lived sign-in transaction is sealed with AES-GCM under the keyring.
 */
export class WebCookies {
  constructor(
    private readonly config: WebConfig,
    private readonly clock: () => number,
  ) {}
  name(purpose: Purpose) {
    return `${this.config.development ? 'phosphor-dev-' : '__Host-phosphor-'}${purpose}`
  }
  private values(c: Context<Env>, purpose: Purpose) {
    const prefix = this.name(purpose) + '='
    return (c.req.header('cookie') ?? '')
      .split(';')
      .map((v) => v.trim())
      .filter((v) => v.startsWith(prefix))
      .map((v) => v.slice(prefix.length))
  }
  /** The session handle, or null. Anything else under the name (an old format) is cleared. */
  handle(c: Context<Env>): string | null {
    const values = this.values(c, 'session')
    if (values.length === 1 && HANDLE.test(values[0]!)) return values[0]!
    if (values.length) this.clear(c, 'session')
    return null
  }
  writeHandle(c: Context<Env>, handle: string, maxAgeSec: number) {
    this.set(c, 'session', handle, maxAgeSec)
  }
  readTransaction(c: Context<Env>): Record<string, unknown> | null {
    const values = this.values(c, 'transaction')
    if (!values.length) return null
    try {
      const [value] = values
      if (values.length !== 1 || value!.length > 3800) throw new Error()
      const [id, encoded, extra] = value!.split('.')
      const key = this.config.keys.get(id!)
      if (!key || !encoded || extra !== undefined) throw new Error()
      const bytes = Buffer.from(encoded, 'base64url')
      if (bytes.length < 29) throw new Error()
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
      decipher.setAAD(Buffer.from(`${this.config.origin}:transaction`))
      decipher.setAuthTag(bytes.subarray(12, 28))
      const data = JSON.parse(
        Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'),
      )
      if (!data || typeof data !== 'object' || !(Number(data.until) > this.clock()))
        throw new Error()
      return data
    } catch {
      this.clear(c, 'transaction')
      throw new ControlFailure('unauthenticated')
    }
  }
  writeTransaction(c: Context<Env>, data: Record<string, unknown> & { until: number }) {
    const [id, key] = this.config.keys.entries().next().value!
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from(`${this.config.origin}:transaction`))
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()])
    const value = `${id}.${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url')}`
    this.set(c, 'transaction', value, Math.max(0, Math.floor((data.until - this.clock()) / 1000)))
  }
  clear(c: Context<Env>, purpose: Purpose) {
    this.set(c, purpose, '', 0)
  }
  private set(c: Context<Env>, purpose: Purpose, value: string, age: number) {
    c.header(
      'Set-Cookie',
      `${this.name(purpose)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${this.config.development ? '' : '; Secure'}`,
      { append: true },
    )
  }
}
