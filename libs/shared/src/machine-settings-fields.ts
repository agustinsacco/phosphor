import { isUuid } from './control-api'

export const text = (v: unknown, max = 300): v is string =>
  typeof v === 'string' && v.length > 0 && v.length <= max && !v.includes('\0')
export const isMachineAccountId = (v: unknown): v is string =>
  v === 'default' || (typeof v === 'string' && isUuid(v))
export const keys = (v: Record<string, unknown>, allowed: string[]) =>
  Object.keys(v).every((k) => allowed.includes(k))
export const repositoryId = (v: unknown): v is string =>
  typeof v === 'string' && /^[a-f0-9]{16}$/.test(v)
export const boundedString = (v: unknown, max = 4096): v is string =>
  typeof v === 'string' && v.length <= max && !v.includes('\0')
