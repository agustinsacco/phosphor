import { execFile } from 'node:child_process'
import { lstat } from 'node:fs/promises'
import { promisify } from 'node:util'
import { errnoIs } from '@phosphor/session-runtime/fs-safety'

export type TrashRunner = (executable: string, argv: string[]) => Promise<void>
const exec = promisify(execFile)
const systemRunner: TrashRunner = async (file, args) => {
  await exec(file, args, { timeout: 20_000 })
}
// No Finder automation. Asking JXA to return a resulting URL via Ref() can
// crash osascript *after* NSFileManager has already moved the transcript.
// `ObjC['import']` is `ObjC.import`; the bracket keeps the Host's import scanners from
// reading the JXA framework name as a module import.
const script = `ObjC['import']('Foundation');
function run(argv) {
  const url = $.NSURL.fileURLWithPath(argv[0]);
  if (!$.NSFileManager.defaultManager.trashItemAtURLResultingItemURLError(url, null, null)) throw Error('Trash failed');
}`

/** Optional replacement for the Host's transcript Trash, for attested owner deletion only. */
export function ownerTrash(
  local: boolean,
  platform: NodeJS.Platform,
  run: TrashRunner = systemRunner,
) {
  if (!local || platform !== 'darwin') return undefined
  return async (file: string) => {
    try {
      await run('/usr/bin/osascript', ['-l', 'JavaScript', '-e', script, file])
    } catch {
      try {
        await lstat(file)
      } catch (error) {
        if (errnoIs(error, 'ENOENT')) return
        throw error
      }
      // Do not leak ENOENT from a missing executable as "the transcript is gone".
      throw new Error('The transcript could not be moved to the Trash.')
    }
  }
}
