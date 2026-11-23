import { beforeEach, expect, it, vi } from 'vitest'
const data = new Map<string, Buffer>()
vi.mock('electron', () => ({
  clipboard: {
    availableFormats: () => [], // macOS does not enumerate our file formats
    readBuffer: (format: string) => data.get(format) ?? Buffer.alloc(0),
    writeBuffer: (format: string, buffer: Buffer) => {
      data.clear()
      data.set(format, buffer)
    },
  },
}))
import { readFileClipboard, uriPaths, writeFilePaths } from './file-clipboard'
beforeEach(() => data.clear())

it('round trips internal copy/cut and does not interpret copied text as file paths', async () => {
  writeFilePaths(['/repo/a', '/repo/b'], true)
  expect(await readFileClipboard()).toEqual({ paths: ['/repo/a', '/repo/b'], cut: true })
  data.clear()
  data.set('text/plain', Buffer.from('/repo/a'))
  expect(await readFileClipboard()).toEqual({ paths: [], cut: false })
})

it('decodes file URL lists', () => {
  const url = 'file:///tmp/a%20b.txt'
  expect(uriPaths(`# comment\nhttps://example.com\n${url}\nfile:%%%`)).toHaveLength(1)
  expect(uriPaths(url)[0]).toContain('a b.txt')
})

it.skipIf(process.platform !== 'darwin')(
  'decodes Finder multi-file plists through macOS',
  async () => {
    data.set(
      'NSFilenamesPboardType',
      Buffer.from(
        '<?xml version="1.0"?><plist version="1.0"><array><string>/tmp/a &amp; b.pdf</string><string>/tmp/folder</string></array></plist>',
      ),
    )
    expect(await readFileClipboard()).toEqual({
      paths: ['/tmp/a & b.pdf', '/tmp/folder'],
      cut: false,
    })
  },
)
