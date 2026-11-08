import { app } from 'electron'
import { join } from 'node:path'

/**
 * Where This Mac keeps the files attached to a lane that moved here from
 * another machine: one folder per session, removed with the session.
 */
export function laneAttachmentsDir(sessionId: string): string {
  return join(app.getPath('userData'), 'lane-attachments', sessionId)
}
