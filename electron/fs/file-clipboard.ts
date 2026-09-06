import { clipboard } from 'electron'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const FORMAT = 'application/x-pidex-file-paths'

/** Our clipboard payload cannot be mistaken for ordinary copied text. */
export function writeFilePaths(paths: string[], cut: boolean): void {
  clipboard.writeBuffer(FORMAT, Buffer.from(JSON.stringify({ paths, cut })))
}

export function uriPaths(text: string): string[] {
  return text.split(/[\r\n]+/).flatMap((line) => {
    if (!line.startsWith('file:')) return []
    try {
      return [fileURLToPath(line)]
    } catch {
      return []
    }
  })
}

/** Windows DROPFILES: byte offset, POINT, fNC, fWide, then a double-NUL list. */
export function dropPaths(buffer: Buffer): string[] {
  if (buffer.length < 20) return []
  const offset = buffer.readUInt32LE(0)
  if (offset < 20 || offset >= buffer.length || !buffer.readUInt32LE(16)) return []
  return buffer.subarray(offset).toString('utf16le').split('\0').filter(Boolean)
}

export async function readFileClipboard(): Promise<{ paths: string[]; cut: boolean }> {
  // macOS omits custom/native file formats from availableFormats(), even
  // when readBuffer can read them. Probe the bytes, not the enumeration.
  const own = clipboard.readBuffer(FORMAT)
  if (own.length) {
    const value = JSON.parse(own.toString())
    if (!Array.isArray(value?.paths) || !value.paths.every((p: unknown) => typeof p === 'string')) {
      throw new Error('Invalid file clipboard')
    }
    return { paths: value.paths, cut: value.cut === true }
  }
  return { paths: await nativeFilePaths(), cut: false }
}

async function nativeFilePaths(): Promise<string[]> {
  const buffer =
    process.platform === 'darwin' ? clipboard.readBuffer('NSFilenamesPboardType') : Buffer.alloc(0)
  if (buffer.length) {
    // Finder's multi-file list is a plist (binary or XML). Let macOS decode it.
    const json = await new Promise<string>((resolve, reject) => {
      const child = execFile(
        '/usr/bin/plutil',
        ['-convert', 'json', '-o', '-', '-'],
        { timeout: 3000, maxBuffer: 1024 * 1024 },
        (error, stdout) => (error ? reject(error) : resolve(stdout)),
      )
      child.stdin?.on('error', () => {})
      child.stdin?.end(buffer)
    })
    const paths: unknown = JSON.parse(json)
    return Array.isArray(paths) ? paths.filter((p): p is string => typeof p === 'string') : []
  }
  if (process.platform === 'win32') {
    const paths = dropPaths(clipboard.readBuffer('CF_HDROP'))
    if (paths.length) return paths
  }
  for (const format of ['text/uri-list', 'public.file-url', 'x-special/gnome-copied-files']) {
    const paths = uriPaths(clipboard.readBuffer(format).toString())
    if (paths.length) return paths
  }
  return []
}
