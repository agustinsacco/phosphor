import { BRAIN_ENTITY_KINDS } from '@shared/brain'

const invalid = (): never => {
  throw new Error('Invalid Brain request.')
}
const text = (value: unknown, max: number): void => {
  if (typeof value !== 'string' || !value.length || value.length > max) invalid()
}
const limit = (value: unknown): void => {
  if (!Number.isInteger(value) || (value as number) < 1 || (value as number) > 50) invalid()
}
const revision = (value: unknown): void => {
  if (!Number.isSafeInteger(value) || (value as number) < 0) invalid()
}

/** Mirror Desktop's Brain argument bounds so browser fixtures cannot conceal refused calls. */
export function checkMockTidyArguments(channel: string, args: unknown[]): void {
  switch (channel) {
    case 'brain:tidyChanges':
      limit(args[0])
      break
    case 'brain:tidyUndo':
      text(args[0], 200)
      revision(args[1])
      break
    case 'brain:describe':
      text(args[0], 200)
      if (typeof args[1] !== 'string') invalid()
      text((args[1] as string).trim(), 160)
      revision(args[2])
      break
    case 'brain:removeName':
      text(args[0], 200)
      text(args[1], 200)
      revision(args[2])
      break
    case 'brain:split':
      checkMockSplit(args)
      break
  }
}

function checkMockSplit(args: unknown[]): void {
  text(args[0], 200)
  const ids = args[1]
  if (!Array.isArray(ids) || !ids.length || ids.length > 200 || new Set(ids).size !== ids.length)
    invalid()
  for (const id of ids as unknown[]) text(id, 200)
  const target = args[2] as Record<string, unknown> | null
  if (!target || typeof target !== 'object' || Object.keys(target).sort().join() !== 'kind,label')
    invalid()
  if (typeof target!.label !== 'string') invalid()
  text((target!.label as string).trim(), 80)
  if (!(BRAIN_ENTITY_KINDS as readonly unknown[]).includes(target!.kind)) invalid()
  revision(args[3])
}
