/**
 * "Is there something newer than what is installed?" — one implementation,
 * used for both pi packages (Settings → Extensions) and Phosphor's own updater.
 *
 * Deliberately not a full semver comparison. Both callers ask the same narrow
 * question about plain dotted versions, and the only consumer of the answer is
 * whether to offer an Update affordance.
 *
 * There used to be two copies with different rules: the renderer's understood
 * prereleases but mapped an unparseable segment to `0`, and the main process's
 * dropped prereleases but refused to claim an update on malformed input. Each
 * was missing the other's protection. The union is what lives here:
 *
 * - a leading `v` is ignored, and missing trailing segments count as `0`
 * - segments compare **numerically**, so `0.1.10` beats `0.1.9` (string
 *   comparison here would have stranded every user on the ninth release)
 * - a prerelease sorts **below** the same plain release, so a `-dev` build
 *   never offers itself as an update to the version it was cut from
 * - anything unparseable answers `false`, because refusing to claim an update
 *   is always safer than inventing one
 */
export function isNewerVersion(candidate: string, current: string): boolean {
  const a = parse(candidate)
  const b = parse(current)
  if (!a || !b) return false

  for (let i = 0; i < Math.max(a.nums.length, b.nums.length); i++) {
    const diff = (a.nums[i] ?? 0) - (b.nums[i] ?? 0)
    if (diff !== 0) return diff > 0
  }

  // Equal release numbers: the prerelease suffix decides. No suffix wins.
  if (a.pre === b.pre) return false
  if (a.pre === '') return true
  if (b.pre === '') return false
  return a.pre > b.pre
}

interface ParsedVersion {
  nums: number[]
  pre: string
}

/** `v1.2.3-dev.0` → `{ nums: [1,2,3], pre: 'dev.0' }`; null if unparseable. */
function parse(value: string): ParsedVersion | null {
  const [core, ...rest] = value.trim().replace(/^v/, '').split('-')
  const nums = core!.split('.').map((part) => Number.parseInt(part, 10))
  if (nums.length === 0 || nums.some(Number.isNaN)) return null
  return { nums, pre: rest.join('-') }
}
