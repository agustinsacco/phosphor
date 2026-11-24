import type { DatabaseSync } from 'node:sqlite'
import { isWithinFolder, rebaseWithinFolder } from '@phosphor/shared/paths'
import { sessionFileName } from '@phosphor/shared/visible-lanes'

export type FolderMove = { from: string; to: string }
/** Identity-preserving updates; never create replacement lanes or drop their marks. */
export class FolderRows {
  constructor(private readonly db: DatabaseSync) {}
  hasArchivedFolder(path: string) {
    return this.db
      .prepare('SELECT cwd FROM lanes JOIN lane_archive_ids USING(lane_id)')
      .all()
      .some((r) => isWithinFolder(String(r.cwd), path))
  }
  rewoundFiles() {
    const rows = this.db
      .prepare(
        `SELECT old.session_file AS predecessor, new.session_file AS successor
      FROM lane_prefs p JOIN lanes old ON old.lane_id=p.value JOIN lanes new ON new.lane_id=p.lane_id
      WHERE p.key='rewound_from' AND old.session_file IS NOT NULL AND new.session_file IS NOT NULL`,
      )
      .all()
    return Object.fromEntries(
      rows.map((r) => [
        sessionFileName(String(r.predecessor)),
        sessionFileName(String(r.successor)),
      ]),
    ) as Record<string, string>
  }
  repoint(moves: readonly FolderMove[], oldRepo: string, newRepo: string) {
    const first = moves[0]!
    const update = this.db.prepare(
      'UPDATE lanes SET repository_id=?,cwd=?,session_file=? WHERE lane_id=?',
    )
    this.db.exec('BEGIN IMMEDIATE')
    try {
      for (const row of this.db
        .prepare('SELECT lane_id,cwd,session_file FROM lanes WHERE repository_id=?')
        .all(oldRepo)) {
        const file = row.session_file === null ? null : String(row.session_file)
        const move = file && moves.find((m) => isWithinFolder(file, m.from))
        update.run(
          newRepo,
          rebaseWithinFolder(String(row.cwd), first.from, first.to),
          move && file ? rebaseWithinFolder(file, move.from, move.to) : file,
          row.lane_id!,
        )
      }
      this.db.exec('COMMIT')
    } catch (error) {
      this.db.exec('ROLLBACK')
      throw error
    }
  }
}
