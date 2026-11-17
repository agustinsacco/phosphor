import { realpath } from 'node:fs/promises'
import type { LaneArchiveEntry, LaneArchiveList } from '@phosphor/shared/lane-archive'
import { directorySize } from '../directory-size'
import { mapLimit } from '../map-limit'
import { parkedTranscript, statIfPresent } from './files'
import type { ArchiveRecord, LaneArchiveStorage } from './storage'

const view = ({
  id,
  title,
  cwd,
  archivedAt,
  state,
  worktree,
}: ArchiveRecord): LaneArchiveEntry => ({
  id,
  title,
  cwd,
  archivedAt,
  state,
  ...(worktree === undefined ? {} : { worktree }),
})

/** Fast listings; expensive size reads run off the request path, two at a time, at most every 10 min. */
export function createArchiveInventory(
  storage: LaneArchiveStorage,
  additionalPaths: (record: ArchiveRecord) => string[] = () => [],
  size: (path: string) => Promise<number | null> = directorySize,
) {
  let cached: { key: string; bytes: number | null; at: number } | undefined
  let measuring: Promise<void> | undefined
  const measure = async (records: ArchiveRecord[], key: string, truncated: boolean) => {
    const paths = new Set<string>()
    for (const record of records) {
      if (record.worktree) paths.add(record.cwd)
      if (record.transcript) {
        paths.add(parkedTranscript(record))
        paths.add(record.transcript.slice(0, -6))
      }
      additionalPaths(record).forEach((path) => paths.add(path))
    }
    const canonical = await mapLimit([...paths], 2, async (path) => {
      if (!(await statIfPresent(path))) return null
      return realpath(path)
    })
    // Count shared directories once, including containment (e.g. attachments within a checkout).
    const roots = [...new Set(canonical.filter((path): path is string => path !== null))].filter(
      (path, _, all) => !all.some((parent) => parent !== path && path.startsWith(`${parent}/`)),
    )
    const sizes = await mapLimit(roots, 2, size)
    cached = {
      key,
      at: Date.now(),
      bytes:
        truncated || sizes.includes(null)
          ? null
          : sizes.reduce<number>((sum, n) => sum + (n ?? 0), 0),
    }
  }
  return {
    invalidate() {
      cached = undefined
    },
    async list(refresh = false): Promise<LaneArchiveList> {
      const { entries, truncated } = await storage.list()
      const key = entries.map((entry) => `${entry.id}:${entry.state}`).join('|')
      if (
        refresh &&
        !measuring &&
        (!cached || cached.key !== key || Date.now() - cached.at >= 600_000)
      ) {
        measuring = measure(entries, key, truncated)
          .catch(() => {
            cached = { key, at: Date.now(), bytes: null }
          })
          .finally(() => {
            measuring = undefined
          })
      }
      const fresh = cached?.key === key ? cached : undefined
      return {
        entries: entries.map(view),
        bytes: fresh?.bytes ?? null,
        measuredAt: fresh?.at ?? null,
        measuring: Boolean(measuring),
        truncated,
      }
    },
  }
}
