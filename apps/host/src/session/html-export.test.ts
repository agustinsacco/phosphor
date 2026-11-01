import { existsSync, readdirSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname } from 'node:path'
import { describe, expect, it, vi } from 'vitest'
import type { RpcCommand, RpcResponse } from '@phosphor/shared/rpc'
import { ExportTooLarge, exportSessionHtml } from './html-export'

const exports = () => readdirSync(tmpdir()).filter((name) => name.startsWith('phosphor-export-'))

/** pi's export_html: write the document where it is told, answer with that path. */
function pi(html: string) {
  const seen: string[] = []
  const command = vi.fn(async (_id: string, request: RpcCommand): Promise<RpcResponse> => {
    if (request.type !== 'export_html' || !request.outputPath) throw new Error('unexpected')
    seen.push(request.outputPath)
    writeFileSync(request.outputPath, html)
    return {
      type: 'response',
      command: 'export_html',
      success: true,
      data: { path: request.outputPath },
    }
  })
  return { command, seen }
}

describe('exportSessionHtml', () => {
  it('exports into a private Host folder, returns the document and leaves no file', async () => {
    const before = exports()
    const { command, seen } = pi('<html>lane</html>')
    await expect(exportSessionHtml(command, 'sid', 1024)).resolves.toBe('<html>lane</html>')
    expect(command).toHaveBeenCalledWith('sid', { type: 'export_html', outputPath: seen[0] })
    expect(dirname(seen[0]!).startsWith(tmpdir())).toBe(true)
    expect(existsSync(dirname(seen[0]!))).toBe(false)
    expect(exports()).toEqual(before)
  })

  it('refuses a document over the cap and still removes the folder', async () => {
    const { command, seen } = pi('x'.repeat(2048))
    await expect(exportSessionHtml(command, 'sid', 1024)).rejects.toBeInstanceOf(ExportTooLarge)
    expect(existsSync(dirname(seen[0]!))).toBe(false)
  })

  it("passes pi's refusal on and removes the folder", async () => {
    const seen: string[] = []
    const command = vi.fn(async (_id: string, request: RpcCommand): Promise<RpcResponse> => {
      if (request.type === 'export_html' && request.outputPath) seen.push(request.outputPath)
      return { type: 'response', command: 'export_html', success: false, error: 'no session' }
    })
    await expect(exportSessionHtml(command, 'sid', 1024)).rejects.toThrow('no session')
    expect(existsSync(dirname(seen[0]!))).toBe(false)
  })
})
