/**
 * The `marks` section: pins and markers through the store, unread as
 * `attention = read + 1`, and Desktop's rewind record as `lane_prefs`
 * `rewound_from` on each successor, holding its predecessor's LANE ID.
 * Desktop keys that record by file name (`RewoundSessions`), never by path.
 */
import { sessionFileName } from '@phosphor/shared/visible-lanes'
import type { HostStore } from '../../lanes/store'
import type { MigrationImporter } from '../migrate'
import { withStateDatabase } from '../staging'
import type { ImportPorts } from './ports'

export interface RewoundLinks {
  /** Successor lane id → predecessor lane id. */
  readonly links: Readonly<Record<string, string>>
  /** Successors that had more than one predecessor; the first in name order won. */
  readonly conflicts: number
  /** Imported successors on a chain that loops back on itself; they get no link. */
  readonly cycles: number
}

/**
 * Desktop's `old → new` file-name record as lane links. A predecessor that was
 * not imported is skipped through: after A → B → C with B absent, C links to A.
 */
export function rewoundLinks(
  rewound: Readonly<Record<string, string>>,
  laneOf: (name: string) => string | undefined,
): RewoundLinks {
  const previous = new Map<string, string>()
  let conflicts = 0
  for (const from of Object.keys(rewound).sort()) {
    const to = sessionFileName(rewound[from]!)
    const name = sessionFileName(from)
    if (to === name) continue
    if (previous.has(to)) conflicts++
    else previous.set(to, name)
  }
  // Each file has one successor, so `previous` is one-to-one: a chain is a path or a loop.
  const onLoop = (start: string) => {
    let current = previous.get(start)
    for (let steps = 0; current !== undefined && steps <= previous.size; steps++) {
      if (current === start) return true
      current = previous.get(current)
    }
    return false
  }
  const links: Record<string, string> = {}
  let cycles = 0
  for (const successor of [...previous.keys()].sort()) {
    const successorLane = laneOf(successor)
    if (!successorLane) continue
    if (onLoop(successor)) {
      cycles++
      continue
    }
    let current = previous.get(successor)
    for (let steps = 0; current !== undefined && !laneOf(current); steps++)
      current = steps < previous.size ? previous.get(current) : undefined
    if (current !== undefined) links[successorLane] = laneOf(current)!
  }
  return { links, conflicts, cycles }
}

/** The lane each imported session file name belongs to. */
function lanesByName(store: HostStore): Map<string, string> {
  const byName = new Map<string, string>()
  for (const lane of store.listLanes())
    if (lane.sessionFile) byName.set(sessionFileName(lane.sessionFile), lane.laneId)
  return byName
}

export function markImporter(ports: ImportPorts): MigrationImporter<'marks'> {
  return {
    async apply(section, { store }) {
      const unread: string[] = []
      let unknown = 0
      for (const item of section.items) {
        const lane = store.sessionLane(item.sessionFile)
        if (!lane || lane.removedAt !== null) {
          unknown++
          continue
        }
        if (item.pinned || item.marker)
          store.setLaneMarks(lane.laneId, {
            ...(item.pinned ? { pinned: true } : {}),
            ...(item.marker ? { marker: item.marker } : {}),
          })
        if (item.unread) unread.push(lane.laneId)
      }
      if (unknown) ports.log('owner.migrate.marks_skipped', { count: unknown })
      const byName = lanesByName(store)
      const { links, conflicts, cycles } = rewoundLinks(section.rewound, (n) => byName.get(n))
      if (conflicts) ports.log('owner.migrate.rewound_conflicts', { count: conflicts })
      if (cycles) ports.log('owner.migrate.rewound_cycles', { count: cycles })
      await withStateDatabase(ports.stateDirectory, ports.uid, (db) => {
        const seen = db.prepare(
          'UPDATE lanes SET attention=read+1 WHERE lane_id=? AND attention<=read',
        )
        const link = db.prepare(
          `INSERT INTO lane_prefs(lane_id,key,value) VALUES (?,'rewound_from',?)
           ON CONFLICT(lane_id,key) DO UPDATE SET value=excluded.value`,
        )
        db.exec('BEGIN IMMEDIATE')
        try {
          for (const id of unread) seen.run(id)
          for (const [successor, predecessor] of Object.entries(links))
            link.run(successor, predecessor)
          db.exec('COMMIT')
        } catch (error) {
          db.exec('ROLLBACK')
          throw error
        }
      })
    },
  }
}
