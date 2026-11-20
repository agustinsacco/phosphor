import { stat } from 'node:fs/promises'
import { laneTitle } from './lane'
import { DeletedLaneError, readLaneEntries, type LaneEntry } from './transcript'

/** Enough for every lane with a job; the oldest title is forgotten first. */
const REMEMBERED_LANES = 2000

/** The file the stored path resolves to now, by size and mtime; null when neither file exists. */
async function laneStamp(path: string): Promise<string | null> {
  for (const candidate of [path, `${path}.archived`]) {
    try {
      const info = await stat(candidate)
      return `${candidate}:${info.size}:${info.mtimeMs}`
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error
    }
  }
  return null
}

export interface CurrentLane {
  title: string
  /** The session header's cwd, null when the header has none. */
  cwd: string | null
  /** Present only when the file had to be read, so its caller can reuse it instead of reading again. */
  entries?: LaneEntry[]
}

/**
 * Lane titles as of each file's last read, so an unchanged lane is never parsed twice. A busy lane
 * is re-read by whoever needs it next, because each write changes its size and mtime.
 */
export class LaneFiles {
  private titles = new Map<string, { stamp: string; title: string; cwd: string | null }>()

  /** Always reads, and remembers the title under the stat taken before the read. */
  async read(path: string): Promise<LaneEntry[]> {
    const stamp = await laneStamp(path).catch(() => null)
    const entries = await readLaneEntries(path)
    if (stamp) this.remember(path, stamp, entries)
    return entries
  }

  /** Reads only when the file changed since its last read; throws DeletedLaneError without reading. */
  async current(path: string): Promise<CurrentLane> {
    const stamp = await laneStamp(path)
    if (stamp === null) {
      this.titles.delete(path)
      throw new DeletedLaneError(path)
    }
    const known = this.titles.get(path)
    if (known?.stamp === stamp) return { title: known.title, cwd: known.cwd }
    const entries = await readLaneEntries(path)
    const { title, cwd } = this.remember(path, stamp, entries)
    return { title, cwd, entries }
  }

  private remember(path: string, stamp: string, entries: LaneEntry[]) {
    const lane = {
      stamp,
      title: laneTitle(entries) ?? '',
      cwd: entries.find((entry) => entry.type === 'session')?.cwd ?? null,
    }
    this.titles.delete(path)
    this.titles.set(path, lane)
    if (this.titles.size > REMEMBERED_LANES) this.titles.delete(this.titles.keys().next().value!)
    return lane
  }
}
