/** Lightweight subsequence fuzzy matcher with basename/boundary bonuses. */

interface FuzzyResult<T> {
  item: T
  score: number
}

/** Characters that start a new word in a path (`src/lib/fuzzy.test.ts`). */
const PATH_BOUNDARIES = new Set(['/', '-', '_', '.'])
/**
 * Same, for a slash command name. `:` is added because every skill is
 * `skill:<name>`: without it `/debug` scored the `d` of `skill:debug` as a
 * mid-word hit while `/mcp` earned a boundary bonus in `mcp-auth`, so skills
 * lost to extensions on exactly the query meant to find them.
 */
const COMMAND_BOUNDARIES = new Set(['/', '-', '_', '.', ':'])

/**
 * Subsequence score, or null when `q` is not a subsequence of `t`. Both must
 * already be lowercased. Consecutive hits compound; a hit at a boundary earns
 * a flat bonus.
 */
function subsequenceScore(q: string, t: string, boundaries: Set<string>): number | null {
  let qi = 0
  let score = 0
  let streak = 0
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      qi++
      streak++
      score += 2 + streak // consecutive matches compound
      if (ti === 0 || boundaries.has(t[ti - 1]!)) score += 6 // boundary bonus
    } else {
      streak = 0
    }
  }
  return qi < q.length ? null : score
}

/** Score one candidate, or null when `query` is not a subsequence of `target`. */
export function fuzzyMatch(query: string, target: string): number | null {
  if (!query) return 0
  const q = query.toLowerCase()
  const t = target.toLowerCase()
  const base = subsequenceScore(q, t, PATH_BOUNDARIES)
  if (base === null) return null
  // Prefer shorter targets and matches near the end (basenames).
  let score = base - Math.floor(target.length / 8)
  const slash = target.lastIndexOf('/')
  if (slash !== -1 && t.slice(slash + 1).includes(q[0]!)) score += 3
  return score
}

export function fuzzyFilter<T>(
  query: string,
  items: T[],
  key: (item: T) => string,
  limit = 50,
): T[] {
  if (!query) return items.slice(0, limit)
  const results: FuzzyResult<T>[] = []
  for (const item of items) {
    const score = fuzzyMatch(query, key(item))
    if (score !== null) results.push({ item, score })
  }
  results.sort((a, b) => b.score - a.score)
  return results.slice(0, limit).map((r) => r.item)
}

/**
 * Score a slash command against what the user has typed after the `/`.
 *
 * Not `fuzzyMatch`: that matcher is tuned for file paths (basename bonus,
 * a length penalty that taxes a 36-character MCP prompt name four points for
 * existing) and the composer needs different answers — an exact name must win
 * outright, `mcp` must put `/mcp` ahead of `/pi-mcp`, and a query that appears
 * nowhere in a name should still find the command whose description says it
 * (`status` → "Show MCP server status").
 *
 * Tiers, in strictly non-overlapping score bands so a lower tier can never
 * outrank a higher one:
 *
 * | tier                           | band      |
 * | ------------------------------ | --------- |
 * | exact name                     | 1000      |
 * | name prefix                    | 700–800   |
 * | a whole segment (`skill:debug`)| 600–700   |
 * | a segment prefix (`pi-mcp`)    | 500–600   |
 * | subsequence of the name        | 200–499   |
 * | substring of the description   | 100       |
 *
 * Within a band, a shorter name ranks higher. Returns 0 for an empty query
 * (everything matches, caller keeps its own order) and null for no match.
 */
export function commandScore(query: string, name: string, description = ''): number | null {
  if (!query) return 0
  const q = query.toLowerCase()
  const n = name.toLowerCase()
  if (n === q) return 1000
  if (n.startsWith(q)) return 800 - Math.min(n.length - q.length, 100)
  const segments = n.split(/[:\-_/.]+/).filter(Boolean)
  if (segments.includes(q)) return 700 - Math.min(n.length, 100)
  if (segments.some((segment) => segment.startsWith(q))) return 600 - Math.min(n.length, 100)
  const sub = subsequenceScore(q, n, COMMAND_BOUNDARIES)
  // Capped so a very long scattered match can never climb into the band above.
  if (sub !== null) return 200 + Math.min(sub, 299) - Math.floor(n.length / 16)
  if (description.toLowerCase().includes(q)) return 100
  return null
}
