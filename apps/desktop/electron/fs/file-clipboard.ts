import { clipboard } from 'electron'
import { execFile } from 'node:child_process'
import { fileURLToPath } from 'node:url'

const FORMAT = 'application/x-phosphor-file-paths'

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
  for (const format of ['text/uri-list', 'public.file-url', 'x-special/gnome-copied-files']) {
    const paths = uriPaths(clipboard.readBuffer(format).toString())
    if (paths.length) return paths
  }
  return []
}
