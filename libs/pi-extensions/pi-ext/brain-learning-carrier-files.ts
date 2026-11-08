import { constants } from 'node:fs'
import { open } from 'node:fs/promises'
import type { BrainLearningUsage } from '@phosphor/shared/brain-learning'

export const LEARNING_CONTROL_LIMIT = 2_000_000
export async function readCarrierFile(
  path: string,
  limit = LEARNING_CONTROL_LIMIT,
): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const before = await file.stat()
    if (!before.isFile() || before.size > limit) throw new Error('Unsafe learning carrier input')
    const bytes = Buffer.alloc(before.size + 1)
    let total = 0
    while (total < bytes.length) {
      const { bytesRead } = await file.read(bytes, total, bytes.length - total, total)
      if (!bytesRead) break
      total += bytesRead
    }
    const after = await file.stat()
    if (total !== before.size || after.mtimeMs !== before.mtimeMs || after.size !== before.size)
      throw new Error('Learning carrier input changed')
    return new TextDecoder('utf-8', { fatal: true }).decode(bytes.subarray(0, total))
  } finally {
    await file.close()
  }
}
export async function writeCarrierFile(path: string, value: unknown): Promise<void> {
  const text = JSON.stringify(value)
  if (Buffer.byteLength(text) > LEARNING_CONTROL_LIMIT)
    throw new Error('Learning carrier output exceeds limit')
  const file = await open(path, 'wx', 0o600)
  try {
    await file.writeFile(text)
    await file.sync()
  } finally {
    await file.close()
  }
}
/** Failed responses may carry only response usage, never arbitrary error/config fields. */
export function carrierErrorUsage(error: unknown): BrainLearningUsage | undefined {
  const usage = (error as { learningUsage?: unknown } | null)?.learningUsage
  if (!usage || typeof usage !== 'object') return undefined
  const raw = usage as Record<string, unknown>
  const number = (key: string) =>
    typeof raw[key] === 'number' && Number.isFinite(raw[key]) && raw[key] >= 0 ? raw[key] : null
  return {
    input: number('input'),
    output: number('output'),
    cacheRead: number('cacheRead'),
    cacheWrite: number('cacheWrite'),
    reasoning: number('reasoning'),
  }
}
export function carrierErrorMessage(error: unknown): string {
  const text = error instanceof Error ? error.message : ''
  if (text.includes('boundRequestVersion'))
    return 'Learning requires pi >=1.4 with ModelRegistry.boundRequestVersion === 1 and prepareBoundRequest; stock pi cannot safely bind the current credential slot without fallback.'
  if (text.includes('explicit read-only'))
    return 'Learning Claude requires an explicit read-only host account assignment.'
  if (text.includes('recorded system checkpoint'))
    return 'Learning source has no recorded system checkpoint.'
  return 'Learning carrier refused or failed; no automatic retry or fallback was attempted.'
}
