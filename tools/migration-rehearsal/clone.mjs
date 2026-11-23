import { spawnSync } from 'node:child_process'
import { constants, createWriteStream } from 'node:fs'
import { lstat, open, utimes } from 'node:fs/promises'
import { basename, dirname } from 'node:path'
import { pipeline } from 'node:stream/promises'
import { hashFile, identity, openVerified } from './manifest.mjs'

// libuv on Darwin returns ENOSYS for COPYFILE_FICLONE_FORCE. cp -c quietly falls back.
// fclonefileat clones the verified descriptor (never reopens its source pathname), exclusively
// creates its target, and lets us distinguish an APFS clone from a plain streamed copy.
const darwinClone = `import ctypes, errno, os, sys
lib = ctypes.CDLL(None, use_errno=True)
result = lib.fclonefileat(3, 4, os.fsencode(sys.argv[1]), 0)
sys.exit(0 if result == 0 else 2 if ctypes.get_errno() in (errno.EXDEV, errno.ENOTSUP, errno.ENOSYS) else 1)`

async function tryClone(file, dest) {
  if (process.platform !== 'darwin') return false
  const directory = dirname(dest),
    dir = await open(directory, constants.O_DIRECTORY | constants.O_NOFOLLOW)
  try {
    const proc = spawnSync(
      '/usr/bin/python3',
      ['-I', '-B', '-S', '-c', darwinClone, basename(dest)],
      {
        stdio: ['ignore', 'ignore', 'ignore', file.fd, dir.fd],
        cwd: directory,
        env: { PATH: '/usr/bin:/bin', HOME: directory, TMPDIR: directory },
        timeout: 15000,
      },
    )
    if (proc.status === 2) return false
    if (proc.status !== 0) throw new Error('Darwin clone helper failed')
    return true
  } finally {
    await dir.close()
  }
}

export async function cloneFile(source, dest, entry) {
  const f = await openVerified(source, entry.slice(1, -1))
  try {
    const cloned = await tryClone(f, dest)
    if (!cloned) {
      await pipeline(
        f.createReadStream({ autoClose: false }),
        createWriteStream(dest, { flags: 'wx', mode: 0o600 }),
      )
      const stat = await f.stat()
      await utimes(dest, stat.atimeMs / 1000, stat.mtimeMs / 1000)
    }
    const stat = await lstat(dest, { bigint: true })
    if (
      (String(stat.dev) === entry[1] && String(stat.ino) === entry[2]) ||
      (await hashFile(dest, identity(stat))) !== entry.at(-1)
    )
      throw new Error('Copy verification failed')
    return cloned
  } finally {
    await f.close()
  }
}
