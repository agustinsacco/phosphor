import { parsePrUrl } from '@shared/github-pr-refs'
import type { GhPrRef } from '@shared/models'
import type { LanePrs } from '../lanePrs'

/**
 * "Track a PR…" input: a pull request URL, or `#123` / `123` in the lane's
 * own repository. Without a home repository a bare number names nothing, so
 * the person is asked for a URL.
 */
export type TrackInput = { ref: GhPrRef } | { error: string }

export function parseTrackInput(text: string, home: LanePrs['home']): TrackInput {
  const value = text.trim()
  const number = /^#?(\d+)$/.exec(value)?.[1]
  if (number) {
    const n = Number(number)
    if (!Number.isSafeInteger(n) || n < 1) return { error: 'That is not a pull request number.' }
    if (!home) return { error: 'This lane has no known repository yet. Paste the PR’s URL.' }
    return { ref: { ...home, number: n } }
  }
  const ref = parsePrUrl(value)
  return ref ? { ref } : { error: 'Paste a pull request URL, or a number like #123.' }
}
