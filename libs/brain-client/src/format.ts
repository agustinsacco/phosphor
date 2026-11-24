import type { BrainSearchResult } from '@phosphor/shared/brain-recall'
import { render } from './format-render'
import { expandParts } from './format-expand'
import { routeParts } from './format-route'
import { searchParts } from './format-search'
export { clip, day, escape } from './format-render'
/** Only memories that fit inside the escaped briefing get a flag reference. */
export function brainBriefing(
  result: BrainSearchResult,
  cwd?: string,
  maxChars = 6000,
  now = Date.now(),
  showIds = false,
) {
  if (result.status !== 'ok')
    return {
      text:
        result.status === 'unavailable'
          ? 'Brain is unavailable right now. This is not a no-match result.'
          : result.mode === 'route'
            ? 'No matching route found.'
            : 'No Brain memories matched.',
      refs: new Map<number, string>(),
    }
  const parts =
    result.mode === 'expand'
      ? expandParts(result)
      : result.mode === 'route'
        ? routeParts(result)
        : searchParts(result, now)
  if (showIds)
    parts.entries = parts.entries.map((e) => ({
      ...e,
      memory: {
        ...e.memory,
        summary: `memory ${e.memory.id} · ${e.memory.summary}${e.memory.entityIds.length ? ' · names ' + e.memory.entityIds.map((id) => `${result.entities.find((n) => n.id === id)?.label ?? id} (entity ${id})`).join(', ') : ''}`,
      },
    }))
  return render(parts, cwd, maxChars, now, result.mode === 'search')
}
export function formatBrainRecall(
  result: BrainSearchResult,
  cwd?: string,
  maxChars = 6000,
  now = Date.now(),
) {
  return brainBriefing(result, cwd, maxChars, now).text
}
