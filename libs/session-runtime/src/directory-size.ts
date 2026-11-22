import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const run = promisify(execFile)

/** Allocated bytes, not recursive JS stats. Unknown on any measurement failure. */
export async function directorySize(path: string): Promise<number | null> {
  try {
    const { stdout } = await run('du', ['-sk', path], { timeout: 30_000 })
    const kb = Number.parseInt(stdout.trim().split(/\s+/)[0] ?? '', 10)
    return Number.isFinite(kb) ? kb * 1024 : null
  } catch {
    return null
  }
}
