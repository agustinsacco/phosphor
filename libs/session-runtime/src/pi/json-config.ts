import { readFile } from 'node:fs/promises'
import { errorText } from '@shared/errors'

/**
 * Result of reading one config file. `malformed` distinguishes "the file is
 * there but we could not read a JSON object" from "there is no file" — the difference
 * matters before writing, because merging a patch onto a failed read would
 * silently discard everything the user had configured.
 */
export interface JsonFileRead<T extends object = Record<string, unknown>> {
  value: T
  exists: boolean
  malformed: boolean
  error?: string
}

/**
 * Read a JSON object config file: absent is fine, unreadable or invalid is reported
 * rather than thrown, and the value degrades to empty either way so callers can still
 * render something. An empty (whitespace-only) file counts as existing but not
 * malformed — pi leaves those behind and writing over one loses nothing.
 */
export async function readJsonFile<T extends object = Record<string, unknown>>(
  path: string,
): Promise<JsonFileRead<T>> {
  const empty = (): T => ({}) as T
  let raw: string
  try {
    raw = await readFile(path, 'utf8')
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      // No file yet — writing a fresh one is safe.
      return { value: empty(), exists: false, malformed: false }
    }
    return { value: empty(), exists: true, malformed: true, error: errorText(error) }
  }
  if (raw.trim().length === 0) {
    return { value: empty(), exists: true, malformed: false }
  }
  try {
    const value: unknown = JSON.parse(raw)
    if (value === null || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error('Expected a JSON object')
    }
    return { value: value as T, exists: true, malformed: false }
  } catch (error) {
    return { value: empty(), exists: true, malformed: true, error: errorText(error) }
  }
}
