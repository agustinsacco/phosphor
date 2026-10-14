import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs'
import { join } from 'node:path'

export const hasCode = (error: unknown, code: string): boolean =>
  error instanceof Error && 'code' in error && error.code === code
export function deadPid(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return false
  } catch (error) {
    return hasCode(error, 'ESRCH')
  }
}
export function acquireInstallLock(lib: string, dead = deadPid): () => void {
  const lock = join(lib, '.install-lock')
  const retired = join(lib, `.install-lock.retired.${process.pid}`)
  const refuse = (): never => {
    throw new Error(`Install lock: ${lock}. Remove it only if no install or update is running.`)
  }
  const remove = (path: string) => {
    try {
      unlinkSync(join(path, 'pid'))
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error
    }
    try {
      if (lstatSync(join(path, 'recovery')).isSymbolicLink()) refuse()
      rmdirSync(join(path, 'recovery'))
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error
    }
    rmdirSync(path)
  }
  const rename = () => {
    try {
      lstatSync(retired)
      refuse()
    } catch (error) {
      if (!hasCode(error, 'ENOENT')) throw error
    }
    renameSync(lock, retired)
  }
  const retire = () => {
    rename()
    remove(retired)
  }
  const owner = () => {
    const file = join(lock, 'pid')
    const info = lstatSync(file)
    if (!info.isFile() || info.isSymbolicLink() || info.size > 20) refuse()
    const text = readFileSync(file, 'utf8')
    if (!/^[1-9][0-9]{0,9}\n$/.test(text)) refuse()
    return Number(text.trim())
  }
  let swept = 0
  for (const name of readdirSync(lib)) {
    const match = /^\.install-lock\.retired\.([1-9][0-9]{0,9})$/.exec(name)
    if (!match?.[1]) continue
    const path = join(lib, name)
    const info = lstatSync(path)
    if (!info.isDirectory() || info.isSymbolicLink()) continue
    if (++swept > 16) break
    if (dead(Number(match[1]))) remove(path)
  }
  try {
    mkdirSync(lock)
  } catch (error) {
    if (!hasCode(error, 'EEXIST')) throw error
    let gate = false
    try {
      const info = lstatSync(lock)
      if (!info.isDirectory() || info.isSymbolicLink()) refuse()
      const pid = owner()
      if (!dead(pid)) refuse()
      mkdirSync(join(lock, 'recovery'))
      gate = true
      if (owner() !== pid || !dead(pid)) refuse()
      rename()
      gate = false
      remove(retired)
      mkdirSync(lock)
    } catch {
      if (gate) rmdirSync(join(lock, 'recovery'))
      refuse()
    }
  }
  try {
    writeFileSync(join(lock, 'pid'), `${process.pid}\n`, { flag: 'wx', mode: 0o600 })
  } catch (error) {
    retire()
    throw error
  }
  return retire
}
