import { createHash } from 'node:crypto'
import { isAbsolute, normalize } from 'node:path'
import { isUuid } from '@phosphor/shared/control-api'
import { HOST_LIMITS, type LaneOp, type Receipt } from '@phosphor/shared/host-protocol'

export function check(ok: boolean): asserts ok {
  if (!ok) throw new Error('Invalid Host state input.')
}
export function uuid(value: string): void {
  check(isUuid(value))
}
export function integer(value: number, minimum = 0): void {
  check(Number.isSafeInteger(value) && value >= minimum)
}
export function text(value: string | null, limit: number, empty = false): void {
  check(
    value === null ||
      (typeof value === 'string' &&
        value.length <= limit &&
        (empty || value.length > 0) &&
        !Array.from(value).some((char) => {
          const code = char.charCodeAt(0)
          return code < 32 || code === 127 || code === 0x2028 || code === 0x2029
        })),
  )
}
export function absolutePath(value: string): void {
  text(value, 4096)
  check(isAbsolute(value) && normalize(value) === value)
}

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

/** Validate receipt metadata separately from arbitrary result data. */
export function storedReceipt(value: unknown): Receipt {
  check(typeof value === 'object' && value !== null && !Array.isArray(value))
  check('requestId' in value && typeof value.requestId === 'string')
  uuid(value.requestId)
  check('status' in value)
  const requestId = value.requestId
  const keys = (allowed: string[]) =>
    check(Object.keys(value).every((key) => allowed.includes(key)))
  switch (value.status) {
    case 'pending':
    case 'unknown':
      keys(['requestId', 'status'])
      return { requestId, status: value.status }
    case 'done': {
      keys(['requestId', 'status', 'data', 'fence', 'laneId'])
      const receipt: {
        requestId: string
        status: 'done'
        data?: unknown
        fence?: number
        laneId?: string
      } = { requestId, status: 'done' }
      if ('fence' in value) {
        check(typeof value.fence === 'number')
        integer(value.fence, 1)
        receipt.fence = value.fence
      }
      if ('laneId' in value) {
        check(typeof value.laneId === 'string')
        uuid(value.laneId)
        receipt.laneId = value.laneId
      }
      if ('data' in value && value.data !== undefined) receipt.data = value.data
      return receipt
    }
    case 'failed': {
      keys(['requestId', 'status', 'error'])
      check(
        'error' in value &&
          typeof value.error === 'object' &&
          value.error !== null &&
          'code' in value.error &&
          'message' in value.error,
      )
      const { code, message } = value.error
      check(code === 'pi-error' || code === 'timeout' || code === 'internal')
      check(typeof message === 'string')
      text(message, HOST_LIMITS.messageChars, true)
      check(Object.keys(value.error).every((key) => key === 'code' || key === 'message'))
      return { requestId, status: 'failed', error: { code, message } }
    }
    case 'rejected': {
      keys(['requestId', 'status', 'code', 'control'])
      check('code' in value)
      const code = value.code
      check(
        code === 'bad-request' ||
          code === 'unsupported' ||
          code === 'forbidden' ||
          code === 'unknown-lane' ||
          code === 'lane-stopped' ||
          code === 'not-controller' ||
          code === 'stale-fence' ||
          code === 'conflict' ||
          code === 'busy' ||
          code === 'too-many-requests',
      )
      if (!('control' in value)) return { requestId, status: 'rejected', code }
      const control = value.control
      check(
        typeof control === 'object' &&
          control !== null &&
          'fence' in control &&
          typeof control.fence === 'number' &&
          'controller' in control,
      )
      integer(control.fence, 1)
      check(Object.keys(control).every((key) => key === 'fence' || key === 'controller'))
      if (control.controller === null)
        return {
          requestId,
          status: 'rejected',
          code,
          control: { fence: control.fence, controller: null },
        }
      const controller = control.controller
      check(
        typeof controller === 'object' &&
          'clientId' in controller &&
          typeof controller.clientId === 'string' &&
          'label' in controller &&
          typeof controller.label === 'string' &&
          'connected' in controller &&
          typeof controller.connected === 'boolean',
      )
      uuid(controller.clientId)
      text(controller.label, HOST_LIMITS.labelChars)
      check(
        Object.keys(control).every((key) => key === 'fence' || key === 'controller') &&
          Object.keys(controller).every((key) => ['clientId', 'label', 'connected'].includes(key)),
      )
      return {
        requestId,
        status: 'rejected',
        code,
        control: {
          fence: control.fence,
          controller: {
            clientId: controller.clientId,
            label: controller.label,
            connected: controller.connected,
          },
        },
      }
    }
    default:
      throw new Error('Invalid Host receipt.')
  }
}
