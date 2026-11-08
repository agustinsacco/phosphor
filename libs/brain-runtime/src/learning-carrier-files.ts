import { lstat, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { readLearningFile } from './learning-source-admission'

export const LEARNING_CARRIER_LIMIT = 2_000_000
export async function writeLearningControl(path: string, value: unknown): Promise<void> {
  const text = JSON.stringify(value)
  if (Buffer.byteLength(text) > LEARNING_CARRIER_LIMIT)
    throw new Error('Learning control exceeds limit')
  await writeFile(path, text, { flag: 'wx', mode: 0o600 })
}
export async function readLearningControl<T>(path: string): Promise<T> {
  return JSON.parse(await readLearningFile(path, LEARNING_CARRIER_LIMIT)) as T
}
/** Root capability and transcript markers must match before any recursive purge. */
export async function purgeLearningRoot(root: string, jobId: string, nonce: string): Promise<void> {
  const exists = await lstat(root).catch((error: NodeJS.ErrnoException) => {
    if (error.code !== 'ENOENT') throw error
    return undefined
  })
  if (!exists) return
  if (!exists.isDirectory() || exists.isSymbolicLink() || (await realpath(root)) !== root)
    throw new Error('Learning cleanup root is unsafe')
  const owner = await readLearningControl<{ jobId?: string; nonce?: string }>(
    join(root, 'owner.json'),
  )
  if (owner.jobId !== jobId || owner.nonce !== nonce)
    throw new Error('Learning cleanup ownership mismatch')
  await auditDirectory(root, jobId)
  await rm(root, { recursive: true, force: true })
}
async function auditDirectory(directory: string, jobId: string): Promise<void> {
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name),
      stat = await lstat(path)
    if (stat.isSymbolicLink() || (!stat.isFile() && !stat.isDirectory()))
      throw new Error('Learning cleanup refuses substituted files')
    if (stat.isDirectory()) {
      await auditDirectory(path, jobId)
      continue
    }
    if (!entry.name.endsWith('.jsonl')) continue
    const text = await readLearningFile(path, 64 * 1024 * 1024)
    const rows = text
      .split('\n')
      .filter(Boolean)
      .flatMap((line) => {
        try {
          return [
            JSON.parse(line) as {
              type?: string
              customType?: string
              data?: { jobId?: string; kind?: string }
            },
          ]
        } catch {
          return []
        } // A killed owned writer may leave an incomplete final record.
      })
    const owners = rows.filter((row) => row.customType === 'phosphor-brain-owner')
    const headerOnlyControl =
      entry.name !== 'source.jsonl' && rows.length === 1 && rows[0]?.type === 'session'

    if (
      (!owners.length && !headerOnlyControl) ||
      owners.some((row) => row.data?.kind !== 'brain' || row.data.jobId !== jobId)
    )
      throw new Error('Learning cleanup transcript ownership mismatch')
  }
}
