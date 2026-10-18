import { escapeRegExp } from '@shared/text-search'
import { parseQuery, squash, tokenize } from '@/lib/modelSearch'
import { SETTINGS_INDEX, tabLabel, type SettingEntry } from './settingsIndex'
import type { SettingsTab } from './settingsUiStore'

/**
 * Search over the settings index. The query grammar is the model picker's
 * (`parseQuery`): words AND together, `"quoted phrases"` keep their spaces,
 * `-word` excludes. Highlighting uses the same parser, so what is emphasised
 * is what matched.
 */

export interface SettingsResultGroup {
  tab: SettingsTab
  label: string
  entries: SettingEntry[]
}

/** Substring, or the same with separators ignored: "autocompaction" finds "Auto-compaction". */
function has(field: string, value: string): boolean {
  const lower = field.toLowerCase()
  if (lower.includes(value)) return true
  const bare = squash(value)
  return bare !== '' && squash(lower).includes(bare)
}

/** Lower is better; null when the entry does not match. */
function rank(entry: SettingEntry, query: string): number | null {
  const terms = parseQuery(query).terms.filter((term) => term.flag === null && term.value)
  const positive = terms.filter((term) => !term.negated).map((term) => term.value)
  if (positive.length === 0) return null
  const haystack = [entry.title, entry.section, tabLabel(entry.tab), entry.keywords].join('\n')
  if (terms.some((term) => term.negated && has(haystack, term.value))) return null
  if (!positive.every((value) => has(haystack, value))) return null
  if (entry.title.toLowerCase().startsWith(positive.join(' '))) return 0
  if (positive.every((value) => has(entry.title, value))) return 1
  if (positive.every((value) => has(`${entry.title}\n${entry.section ?? ''}`, value))) return 2
  return 3
}

/**
 * Matching entries on `available` tabs, grouped by tab. Groups are ordered by
 * their best match, entries by rank and then the order the tab shows them, so
 * the first result is the best one.
 */
export function searchSettings(
  query: string,
  available: ReadonlySet<SettingsTab>,
  index: SettingEntry[] = SETTINGS_INDEX,
): SettingsResultGroup[] {
  const ranked = index
    .map((entry, order) => ({ entry, order, rank: rank(entry, query) }))
    .filter((hit): hit is typeof hit & { rank: number } => hit.rank !== null)
    .filter((hit) => available.has(hit.entry.tab))
    .sort((a, b) => a.rank - b.rank || a.order - b.order)

  const groups = new Map<SettingsTab, SettingsResultGroup>()
  for (const { entry } of ranked) {
    const group = groups.get(entry.tab)
    if (group) group.entries.push(entry)
    else groups.set(entry.tab, { tab: entry.tab, label: tabLabel(entry.tab), entries: [entry] })
  }
  return [...groups.values()]
}

/**
 * What to paint in an open tab: every highlighted term and its separator-split
 * parts, as `highlightRanges` emphasises them. Null when there is nothing.
 */
export function highlightPattern(query: string): RegExp | null {
  const needles = new Set<string>()
  for (const term of parseQuery(query).highlightTerms) {
    needles.add(term)
    for (const part of tokenize(term)) needles.add(part)
  }
  if (needles.size === 0) return null
  // Longest first, so the alternation prefers the whole term to its parts.
  const source = [...needles]
    .sort((a, b) => b.length - a.length)
    .map(escapeRegExp)
    .join('|')
  return new RegExp(source, 'gi')
}
