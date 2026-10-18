import { PACKAGES } from '../size-budget.mjs'

/** Package-relative file mappings can be merged directly into a budget's renames. */
export function budgetRenames(contents, moves) {
  const result = {}
  for (const [name, root] of Object.entries(PACKAGES)) {
    const content = contents.get(`tools/budgets/${name}.json`)
    if (!content) continue
    const budget = JSON.parse(content.toString('utf8'))
    const prefix = root ? `${root}/` : ''
    const destinations = new Map(
      moves
        .filter(({ from }) => from.startsWith(prefix))
        .map(({ from, to }) => [from.slice(prefix.length), to.slice(prefix.length)]),
    )
    const renames = {}
    const baselineFiles = [
      ...new Set(Object.keys(budget.offenders).map((key) => key.split('::')[0])),
    ].sort()
    for (const from of baselineFiles) {
      const current = budget.renames[from] ?? from
      const to = destinations.get(current)
      if (to) renames[from] = to
    }
    if (Object.keys(renames).length) result[name] = renames
  }
  return result
}
