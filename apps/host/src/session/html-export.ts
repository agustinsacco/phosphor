import { constants } from 'node:fs'
import { mkdtemp, open, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import type { RpcCommand, RpcResponse } from '@phosphor/shared/rpc'

/** The export is larger than one call result may carry. */
export class ExportTooLarge extends Error {}

/**
 * Export a running session to HTML and return the document, leaving no file.
 *
 * pi only exports to a file. Without a path it writes into the session's cwd,
 * which on a Host is the user's worktree. So the Host names a file in a private
 * (0700) folder it creates, reads it back and removes the folder. A client never
 * names a path, and this is the only caller allowed to pass `outputPath`.
 *
 * The read-back trusts nothing about the file: pi must report the path it was
 * given, the file must be a regular file reached without a symlink, and no more
 * than `maxBytes + 1` bytes are ever read, whatever its size says.
 */
export async function exportSessionHtml(
  command: (id: string, command: RpcCommand) => Promise<RpcResponse>,
  id: string,
  maxBytes: number,
): Promise<string> {
  const folder = await mkdtemp(join(tmpdir(), 'phosphor-export-'))
  try {
    const outputPath = join(folder, 'session.html')
    const response = await command(id, { type: 'export_html', outputPath })
    if (!response.success) throw new Error(response.error)
    const data = response.data as { path?: unknown } | undefined
    if (data?.path !== outputPath) throw new Error('pi exported somewhere else')
    return await readCapped(outputPath, maxBytes)
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}

async function readCapped(path: string, maxBytes: number): Promise<string> {
  const file = await open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const stat = await file.stat()
    if (!stat.isFile()) throw new Error('the export is not a file')
    if (stat.size > maxBytes) throw new ExportTooLarge('the export is too large')
    const buffer = Buffer.alloc(maxBytes + 1)
    let length = 0
    for (;;) {
      const { bytesRead } = await file.read(buffer, length, buffer.length - length, length)
      if (bytesRead === 0) break
      length += bytesRead
      if (length > maxBytes) throw new ExportTooLarge('the export is too large')
    }
    return buffer.toString('utf8', 0, length)
  } finally {
    await file.close()
  }
}
