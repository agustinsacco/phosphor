import {
  constants,
  closeSync,
  fstatSync,
  openSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'
import type { TerminalSummary } from '@phosphor/shared/host-protocol-terminals'

/** Only terminal identities/status are durable. Never persist output or input. */
export function terminalState(directory: string) {
  const file = join(directory, 'terminals.json')
  return {
    load(): unknown {
      let fd: number
      try {
        fd = openSync(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
      } catch (error) {
        if (error instanceof Error && 'code' in error && error.code === 'ENOENT') return []
        throw new Error('Terminal state unavailable', { cause: error })
      }
      try {
        const stat = fstatSync(fd)
        if (!stat.isFile() || stat.size > 8192) throw new Error('Invalid terminal state')
        return JSON.parse(readFileSync(fd, 'utf8'))
      } finally {
        closeSync(fd)
      }
    },
    save(rows: TerminalSummary[]) {
      const temp = join(directory, 'terminals.tmp')
      // The state directory is private and the Host process owns its lock.
      const fd = openSync(
        temp,
        constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
        0o600,
      )
      try {
        writeFileSync(fd, JSON.stringify(rows))
      } finally {
        closeSync(fd)
      }
      renameSync(temp, file)
    },
  }
}
