import { expect, it } from 'vitest'
import { emptyBrainTidyPage, type BrainTidyPage, type BrainTidyRun } from '@shared/brain-tidy'
import { tidyStatus } from './tidyStatus'

function finished(suggestions: number, folded: number): BrainTidyPage {
  const run: BrainTidyRun = {
    state: 'done',
    checked: 1,
    total: 1,
    suggestions,
    folded,
    startedAt: 1,
    finishedAt: 2,
    message: null,
    error: null,
  }
  return { ...emptyBrainTidyPage(), run }
}
it.each([
  [1, 1, 'Found 1 thing to tidy and folded 1 exact repeat.'],
  [3, 2, 'Found 3 things to tidy and folded 2 exact repeats.'],
  [3, 0, 'Found 3 things to tidy.'],
  [0, 1, 'Folded 1 exact repeat.'],
  [0, 0, 'Nothing to tidy.'],
])('a finished run that found %i and folded %i reads "%s"', (suggestions, folded, text) => {
  expect(tidyStatus(finished(suggestions, folded))).toBe(text)
})
it('counts one memory, one person or thing and one pair in the singular', () => {
  const page = emptyBrainTidyPage()
  page.coverage = {
    ...page.coverage,
    phase: 'done',
    memories: 1,
    totalMemories: 1,
    totalEntities: 1,
    startedAt: 1,
    finishedAt: null,
  }
  expect(tidyStatus(page)).toBe('Checked all 1 memory and 1 person or thing')
  page.coverage.phase = 'memories'
  expect(tidyStatus(page)).toBe('Checked 1 of 1 memory so far')
  const cancelled = finished(0, 0)
  cancelled.run = { ...cancelled.run!, state: 'cancelled', checked: 0, total: 1 }
  expect(tidyStatus(cancelled)).toBe('Tidy cancelled after checking 0 of 1 pair.')
})
