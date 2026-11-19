import type { BrainPrefs } from './brain'

const word = /[\p{L}\p{N}]/u

export function brainTitleNeverRead(prefs: BrainPrefs['neverRead'], title: string): boolean {
  const lower = title.toLowerCase()
  return prefs.titles.some((pattern) => {
    const needle = pattern.toLowerCase()
    for (let at = lower.indexOf(needle); at !== -1; at = lower.indexOf(needle, at + 1)) {
      const before = Array.from(lower.slice(0, at)).at(-1) ?? ''
      const after = String.fromCodePoint(lower.codePointAt(at + needle.length) ?? 0)
      if (!word.test(before) && !word.test(after)) return true
    }
    return false
  })
}

export function brainLaneNeverRead(
  prefs: BrainPrefs['neverRead'],
  lane: { sessionId: string; title: string },
): boolean {
  return prefs.sessionIds.includes(lane.sessionId) || brainTitleNeverRead(prefs, lane.title)
}

export function checkBrainNeverRead(value: unknown): BrainPrefs['neverRead'] {
  const candidate = value as Partial<BrainPrefs['neverRead']> | null
  const valid = (items: unknown, limit: number, size: number): items is string[] =>
    Array.isArray(items) &&
    items.length <= limit &&
    Array.from(items).every(
      (item) => typeof item === 'string' && item.trim().length > 0 && item.length <= size,
    )
  if (!valid(candidate?.titles, 50, 80) || !valid(candidate?.sessionIds, 5000, 200))
    throw new Error('Invalid Brain never-read settings.')
  return { titles: candidate.titles, sessionIds: candidate.sessionIds }
}

export function setBrainLaneNeverRead(
  prefs: BrainPrefs,
  sessionId: string,
  never: boolean,
): BrainPrefs {
  if (
    typeof sessionId !== 'string' ||
    sessionId.length > 200 ||
    !sessionId.trim() ||
    typeof never !== 'boolean'
  )
    throw new Error('Invalid Brain never-read lane.')
  const sessionIds = new Set(prefs.neverRead.sessionIds)
  if (never) sessionIds.add(sessionId)
  else sessionIds.delete(sessionId)
  return {
    ...prefs,
    neverRead: checkBrainNeverRead({ ...prefs.neverRead, sessionIds: [...sessionIds] }),
  }
}
