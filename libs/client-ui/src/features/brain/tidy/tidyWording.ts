import { formatCount } from '@/lib/format'

/**
 * What a finished Tidy run found, without its subject: "found 2 things to tidy and folded 1
 * exact repeat". Null when it found and folded nothing.
 */
export function tidyFindings(suggestions: number, folded: number): string | null {
  const parts = [
    suggestions ? `found ${formatCount(suggestions, 'thing to tidy', 'things to tidy')}` : '',
    folded ? `folded ${formatCount(folded, 'exact repeat')}` : '',
  ]
  return parts.filter(Boolean).join(' and ') || null
}
