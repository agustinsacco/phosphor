import type { BrainMemory } from '@shared/brain'
import { MEMORY_TYPE_WORDS } from '../memoryLabels'
import { formatCount } from '@/lib/format'

const KIND_WORDS: Record<BrainMemory['kind'], string> = {
  observed: 'seen',
  reported: 'told',
  inferred: 'guessed',
}

/** Whether a memory still holds: replaced, ended on a date, disputed, or still true. */
export function memoryStanding(memory: BrainMemory, now: number): string {
  if (memory.state === 'superseded') return 'replaced'
  if (memory.validTo !== null && memory.validTo <= now)
    return `ended ${new Date(memory.validTo).toISOString().slice(0, 10)}`
  return memory.state === 'disputed' ? 'disputed' : 'still true'
}

/** "decision · still true · you said it · told · 2 lanes · important". */
export function memoryWords(memory: BrainMemory, now: number): string {
  return [
    MEMORY_TYPE_WORDS[memory.type].toLowerCase(),
    memoryStanding(memory, now),
    memory.saidBy === 'you' ? 'you said it' : 'an agent said it',
    KIND_WORDS[memory.kind],
    formatCount(memory.lanes, 'lane'),
    memory.importance === 2 ? 'important' : '',
  ]
    .filter(Boolean)
    .join(' · ')
}
