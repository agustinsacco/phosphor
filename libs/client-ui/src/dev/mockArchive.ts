import type { LaneArchiveEntry, LaneArchiveList } from '@shared/lane-archive'

/** Metadata-only browser harness. Never represents a destructive filesystem operation. */
export function createMockArchive<T>(
  describe: (value: T) => Pick<LaneArchiveEntry, 'title' | 'cwd' | 'worktree'>,
) {
  const entries = new Map<string, { entry: LaneArchiveEntry; value: T }>()
  return {
    add(value: T) {
      const id = crypto.randomUUID()
      entries.set(id, {
        value,
        entry: { id, ...describe(value), archivedAt: Date.now(), state: 'archived' },
      })
    },
    list(): LaneArchiveList {
      return {
        entries: [...entries.values()].map(({ entry }) => entry),
        bytes: 0,
        measuredAt: Date.now(),
        measuring: false,
        truncated: false,
      }
    },
    remove(id: unknown): T {
      const record = typeof id === 'string' && entries.get(id)
      if (!record) throw new Error('Archive not found.')
      entries.delete(record.entry.id)
      return record.value
    },
  }
}
