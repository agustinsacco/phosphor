import {
  constants,
  closeSync,
  fstatSync,
  lstatSync,
  openSync,
  readSync,
  renameSync,
  rmSync,
  chmodSync,
  fsyncSync,
  writeFileSync,
} from 'node:fs'
import { randomUUID } from 'node:crypto'
import { dirname, join, resolve } from 'node:path'
import { errnoIs } from '../fs-safety'

export function readBounded(path: string, cap: number): string {
  const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK)
  try {
    const info = fstatSync(fd)
    if (!info.isFile() || info.size > cap) throw new Error('Invalid update record')
    const buffer = Buffer.alloc(cap + 1)
    const size = readSync(fd, buffer, 0, buffer.length, 0)
    if (size > cap) throw new Error('Invalid update record')
    return buffer.subarray(0, size).toString('utf8')
  } finally {
    closeSync(fd)
  }
}
export function atomicRecord(path: string, value: unknown, mode: number): void {
  const temp = join(dirname(path), `.update-${randomUUID()}`)
  try {
    writeFileSync(temp, JSON.stringify(value) + '\n', { mode, flag: 'wx' })
    chmodSync(temp, mode)
    const fd = openSync(temp, constants.O_RDONLY)
    try {
      fsyncSync(fd)
    } finally {
      closeSync(fd)
    }
    renameSync(temp, path)
  } finally {
    rmSync(temp, { force: true })
  }
}
/** Never follow any ancestor link when removing a directory. Missing folders are safe. */
export function checkedFolder(
  path: string,
  expected: string,
  home: string,
  uid: number | undefined,
): boolean {
  if (uid === undefined || path !== resolve(expected) || path === '/' || path === resolve(home))
    throw new Error('Unsafe uninstall folder')
  let parent = path
  while (parent !== '/') {
    try {
      const info = lstatSync(parent)
      if (!info.isDirectory() || info.isSymbolicLink() || (parent === path && info.uid !== uid))
        throw new Error('Unsafe uninstall folder')
    } catch (error) {
      if (!(error instanceof Error && errnoIs(error, 'ENOENT'))) throw error
      if (parent === path) return false
    }
    parent = dirname(parent)
  }
  return true
}
