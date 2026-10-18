import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto'
import type { Context } from 'hono'
import type { Env } from '../http'
import { ControlFailure } from '../http'
import type { WebConfig } from './config'

export class WebCookies {
  constructor(
    private readonly config: WebConfig,
    private readonly clock: () => number,
  ) {}
  name(purpose: 'session' | 'transaction') {
    return `${this.config.development ? 'phosphor-dev-' : '__Host-phosphor-'}${purpose}`
  }
  read(c: Context<Env>, purpose: 'session' | 'transaction'): Record<string, unknown> | null {
    const matches = (c.req.header('cookie') ?? '')
      .split(';')
      .map((v) => v.trim())
      .filter((v) => v.startsWith(this.name(purpose) + '='))
    if (!matches.length) return null
    try {
      if (matches.length !== 1) throw new Error()
      const value = matches[0]!.slice(this.name(purpose).length + 1)
      if (value.length > 3800) throw new Error()
      const [id, encoded, extra] = value.split('.')
      const key = this.config.keys.get(id!)
      if (!key || !encoded || extra !== undefined) throw new Error()
      const bytes = Buffer.from(encoded, 'base64url')
      if (bytes.toString('base64url') !== encoded || bytes.length < 29) throw new Error()
      const decipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(0, 12))
      decipher.setAAD(Buffer.from(`${this.config.origin}:${purpose}`))
      decipher.setAuthTag(bytes.subarray(12, 28))
      const data = JSON.parse(
        Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString('utf8'),
      )
      if (
        !data ||
        typeof data !== 'object' ||
        !Number.isSafeInteger(data.until) ||
        data.until <= this.clock()
      )
        throw new Error()
      return data
    } catch {
      this.clear(c, purpose)
      throw new ControlFailure('unauthenticated')
    }
  }
  write(c: Context<Env>, purpose: 'session' | 'transaction', data: Record<string, unknown>) {
    const [id, key] = this.config.keys.entries().next().value!
    const iv = randomBytes(12)
    const cipher = createCipheriv('aes-256-gcm', key, iv)
    cipher.setAAD(Buffer.from(`${this.config.origin}:${purpose}`))
    const ciphertext = Buffer.concat([cipher.update(JSON.stringify(data)), cipher.final()])
    const value = `${id}.${Buffer.concat([iv, cipher.getAuthTag(), ciphertext]).toString('base64url')}`
    if (value.length > 3800) throw new ControlFailure('unavailable')
    this.set(c, purpose, value, Math.max(0, Math.floor((Number(data.until) - this.clock()) / 1000)))
  }
  clear(c: Context<Env>, purpose: 'session' | 'transaction') {
    this.set(c, purpose, '', 0)
  }
  private set(c: Context<Env>, purpose: 'session' | 'transaction', value: string, age: number) {
    c.header(
      'Set-Cookie',
      `${this.name(purpose)}=${value}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${age}${this.config.development ? '' : '; Secure'}`,
      { append: true },
    )
  }
}
