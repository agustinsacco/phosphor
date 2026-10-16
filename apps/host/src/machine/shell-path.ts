import {
  constants,
  openSync,
  closeSync,
  fstatSync,
  readFileSync,
  writeSync,
  ftruncateSync,
} from 'node:fs'
import { join } from 'node:path'

// Keep byte-for-byte in sync with the installer's marked block.
export const HOST_PATH_BLOCK = `
# >>> Phosphor Host PATH >>>
case ":$PATH:" in
  *:"$HOME/.local/bin":*) ;;
  *) export PATH="$HOME/.local/bin:$PATH" ;;
esac
# <<< Phosphor Host PATH <<<
`

/** Remove only our exact block from regular, user-owned startup files. Never follow links. */
export function removeHostPathBlocks(home: string, uid: number | undefined): void {
  if (uid === undefined) return
  for (const name of ['.zshrc', '.bashrc', '.profile']) {
    let fd: number | undefined
    try {
      fd = openSync(
        join(home, name),
        constants.O_RDWR | constants.O_NOFOLLOW | constants.O_NONBLOCK,
      )
      const info = fstatSync(fd)
      if (!info.isFile() || info.uid !== uid || info.size > 1024 * 1024) continue
      const before = readFileSync(fd)
      const block = Buffer.from(HOST_PATH_BLOCK)
      const start = before.indexOf(block)
      if (start < 0) continue
      const bytes = Buffer.concat([
        before.subarray(0, start),
        before.subarray(start + block.length),
      ])
      let written = 0
      while (written < bytes.length)
        written += writeSync(fd, bytes, written, bytes.length - written, written)
      ftruncateSync(fd, bytes.length)
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code
      if (!['ENOENT', 'ELOOP', 'EACCES', 'EPERM', 'ENXIO', 'EISDIR'].includes(code ?? ''))
        throw error
    } finally {
      if (fd !== undefined) closeSync(fd)
    }
  }
}
