import { BRAIN_TIDY_KINDS, checkBrainTidyAction } from '@shared/brain-tidy'

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
    case 'brain:tidy':
      if (args[0] !== null && !(BRAIN_TIDY_KINDS as readonly unknown[]).includes(args[0])) invalid()
      if (args[1] !== null) text(args[1], 512)
      limit(args[2])
      break
    case 'brain:tidyChanges':
      limit(args[0])
      break
    case 'brain:tidySuggestion':
      text(args[0], 200)
      break
    case 'brain:tidyApply':
      text(args[0], 200)
      checkBrainTidyAction(args[1])
      revision(args[2])
      break
    case 'brain:tidyDismiss':
    case 'brain:tidyUndo':
      text(args[0], 200)
      revision(args[1])
      break
  }
}
