import { isAbsolute, normalize } from 'node:path'
import { isUuid } from '@phosphor/shared/control-api'

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
