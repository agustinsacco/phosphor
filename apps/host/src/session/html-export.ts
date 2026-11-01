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
    const file = await open(outputPath, 'r')
    try {
      if ((await file.stat()).size > maxBytes) throw new ExportTooLarge('the export is too large')
      return await file.readFile('utf8')
    } finally {
      await file.close()
    }
  } finally {
    await rm(folder, { recursive: true, force: true })
  }
}
