/** Stable input order is the creation-order fallback. New sessions stay at the top. */
export function orderedSessions<T extends { path?: string }>(items: T[], order: string[]): T[] {
  const rank = new Map(order.map((path, index) => [path, index]))
  return [...items].sort((a, b) => (rank.get(a.path ?? '') ?? -1) - (rank.get(b.path ?? '') ?? -1))
}

/** A drop is relative to a row, never a stale numeric index. */
export function moveSession(
  paths: string[],
  source: string,
  target: string,
  after: boolean,
): string[] {
  if (source === target || !paths.includes(source) || !paths.includes(target)) return paths
  const next = paths.filter((path) => path !== source)
  next.splice(next.indexOf(target) + Number(after), 0, source)
  return next.every((path, index) => path === paths[index]) ? paths : next
}
