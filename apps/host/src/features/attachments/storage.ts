import { lstatSync, readdirSync, realpathSync, rmSync } from 'node:fs'
import { dirname, join } from 'node:path'
import {
  ATTACHMENT_LIMITS as LIMIT,
  attachmentId,
} from '@phosphor/shared/host-protocol-attachments'
import { prepareStateDirectory } from '../../lanes/state-dir'
import { laneIdPattern, type AttachmentState, type Upload } from './state'

export function directory(path: string) {
  prepareStateDirectory(path, process.getuid?.())
  if (realpathSync(path) !== path) throw new Error('unsafe-storage')
}
export function laneDirectory(base: string, laneId: string) {
  if (!laneIdPattern.test(laneId)) throw new Error('bad-request')
  directory(base)
  const path = join(base, laneId)
  directory(path)
  return path
}
export function discard(state: AttachmentState, id: string, upload: Upload) {
  state.uploads.delete(id)
  try {
    for (const path of [state.temporary, dirname(upload.path)]) {
      const stat = lstatSync(path)
      if (!stat.isDirectory() || stat.isSymbolicLink() || realpathSync(path) !== path)
        throw new Error('unsafe-storage')
    }
    if (dirname(upload.path) !== join(state.temporary, upload.laneId))
      throw new Error('unsafe-storage')
    rmSync(upload.path, { force: true })
  } catch {
    state.ports.log?.('attachments.cleanup-refused')
  }
}
export function abort(state: AttachmentState, laneId: string) {
  for (const [id, upload] of state.uploads) if (upload.laneId === laneId) discard(state, id, upload)
}
export function remove(state: AttachmentState, laneId: string) {
  if (!laneIdPattern.test(laneId)) return
  abort(state, laneId)
  for (const base of [state.root, state.temporary]) {
    directory(base)
    // rm does not follow symbolic links, including links inside a directory.
    rmSync(join(base, laneId), { recursive: true, force: true })
  }
}
export function sweep(state: AttachmentState) {
  for (const [id, upload] of state.uploads)
    if (state.now() - upload.started >= LIMIT.lifetimeMs || !state.ports.laneExists(upload.laneId))
      discard(state, id, upload)
  for (const base of [state.root, state.temporary]) {
    directory(base)
    for (const laneId of readdirSync(base)) {
      const path = join(base, laneId)
      const info = lstatSync(path)
      if (!laneIdPattern.test(laneId) || !info.isDirectory() || info.isSymbolicLink()) continue
      if (!state.ports.laneExists(laneId)) {
        remove(state, laneId)
        continue
      }
      if (base !== state.temporary) continue
      for (const name of readdirSync(path)) {
        if (!attachmentId(name)) continue
        const file = join(path, name)
        const stat = lstatSync(file)
        if (
          stat.isFile() &&
          !stat.isSymbolicLink() &&
          state.now() - stat.mtimeMs >= LIMIT.lifetimeMs
        )
          rmSync(file)
      }
    }
  }
}
export function startSweep(state: AttachmentState) {
  sweep(state)
  state.timer = setInterval(() => {
    try {
      sweep(state)
    } catch {
      /* Retry without leaking filesystem errors. */
    }
  }, 60000)
  state.timer.unref()
}
export function close(state: AttachmentState) {
  clearInterval(state.timer)
  for (const [id, upload] of state.uploads) discard(state, id, upload)
}
