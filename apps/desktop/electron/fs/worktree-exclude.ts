import { appendFile, mkdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { git } from '@phosphor/session-runtime/git/git-exec'

/** Append `/.phosphor/` to .git/info/exclude once (never touches .gitignore). */
export async function ensureExcluded(repoPath: string): Promise<void> {
  const commonDir = (
    await git(repoPath, ['rev-parse', '--path-format=absolute', '--git-common-dir'])
  ).trim()
  const excludePath = join(commonDir, 'info', 'exclude')
  let existing = ''
  try {
    existing = await readFile(excludePath, 'utf8')
  } catch {
    // no exclude file yet
  }
  if (existing.split('\n').some((l) => l.trim() === '/.phosphor/')) return
  await mkdir(join(commonDir, 'info'), { recursive: true })
  await appendFile(excludePath, `${existing.endsWith('\n') || !existing ? '' : '\n'}/.phosphor/\n`)
}
