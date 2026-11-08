import { absoluteTime } from '@/lib/time'

export function formatBrainTime(value: number | null): string {
  return value === null ? 'unspecified' : absoluteTime(value)
}
