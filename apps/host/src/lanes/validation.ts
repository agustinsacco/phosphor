import { createHash } from 'node:crypto'
import { HOST_LIMITS, type LaneOp } from '@phosphor/shared/host-protocol'
import { check } from './validation-primitives'

export { check, uuid, integer, text, absolutePath } from './validation-primitives'
export { storedReceipt } from './receipt-validation'

export class JsonTooLarge extends Error {}

/** Only JSON values, bounded by UTF-8 bytes and a depth of 64. */
export function canonicalJson(
  value: unknown,
  limit: number = HOST_LIMITS.inboundFrameBytes,
): string {
  let budget = limit
  const seen = new Set<object>()
  function consume(bytes: number): void {
    budget -= bytes
    if (budget < 0) throw new JsonTooLarge('Host JSON size limit exceeded.')
  }
  function encode(item: unknown, depth: number): string {
    check(depth <= 64)
    if (
      item === null ||
      typeof item === 'boolean' ||
      typeof item === 'string' ||
      typeof item === 'number'
    ) {
      check(typeof item !== 'number' || Number.isFinite(item))
      if (typeof item === 'string' && item.length > budget)
        throw new JsonTooLarge('Host JSON size limit exceeded.')
      const encoded = JSON.stringify(item)
      consume(Buffer.byteLength(encoded))
      return encoded
    }
    check(typeof item === 'object' && item !== null && !seen.has(item))
    check(
      Array.isArray(item) ||
        Object.getPrototypeOf(item) === Object.prototype ||
        Object.getPrototypeOf(item) === null,
    )
    seen.add(item)
    consume(2)
    const parts: string[] = []
    if (Array.isArray(item)) {
      if (item.length > budget + 1) throw new JsonTooLarge('Host JSON size limit exceeded.')
      for (const child of item) {
        if (parts.length) consume(1)
        parts.push(encode(child, depth + 1))
      }
    } else {
      const keys = Object.keys(item).sort()
      if (keys.length > budget + 1) throw new JsonTooLarge('Host JSON size limit exceeded.')
      for (const key of keys) {
        if (parts.length) consume(1)
        consume(1)
        check(key in item)
        const descriptor = Object.getOwnPropertyDescriptor(item, key)
        check(descriptor !== undefined && 'value' in descriptor)
        parts.push(`${encode(key, depth + 1)}:${encode(descriptor.value, depth + 1)}`)
      }
    }
    seen.delete(item)
    return Array.isArray(item) ? `[${parts.join(',')}]` : `{${parts.join(',')}}`
  }
  return encode(value, 0)
}
export function opHash(op: LaneOp): string {
  return createHash('sha256').update(canonicalJson(op)).digest('hex')
}
