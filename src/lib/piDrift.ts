/**
 * "Is the installed pi newer than the one Phosphor was verified against?"
 *
 * The About tab shows a drift warning from this, so the comparison has to
 * survive pi leaving 0.x: reading only `version.split('.')[1]` made pi 1.0
 * compare as minor 0 and silenced the banner forever. Compare the
 * `major.minor` pair instead, and stay quiet whenever the version does not
 * parse — an unfamiliar shape is not evidence of drift.
 */

/** Newest pi minor line Phosphor has been verified against, as `major.minor`. */
export const VERIFIED_PI_LINE = '0.85'

function parseLine(version: string): [number, number] | null {
  const parts = version.trim().split('.')
  const major = Number(parts[0])
  const minor = Number(parts[1] ?? 0)
  if (!Number.isFinite(major) || !Number.isFinite(minor)) return null
  return [major, minor]
}

/**
 * True when `installed` is on a newer minor line than `verified`.
 * A patch release of the verified line (0.85.7 vs `0.85`) is not drift.
 */
export function isPiNewerThanVerified(
  installed: string | undefined | null,
  verified: string = VERIFIED_PI_LINE,
): boolean {
  if (!installed) return false
  const a = parseLine(installed)
  const b = parseLine(verified)
  if (!a || !b) return false
  return a[0] > b[0] || (a[0] === b[0] && a[1] > b[1])
}
