import { FILE_LIMITS, type GitStatus } from '@phosphor/shared/host-protocol-files'
import { checkedPath, FileFailure, safeGit } from '../files'

export async function parseGitStatus(
  root: string,
  prefix: string,
  raw: string,
): Promise<Record<string, string>> {
  const entries = raw.split('\0')
  const status: Record<string, string> = Object.create(null)
  let count = 0
  for (let i = 0; i < entries.length; i++) {
    const entry = entries[i]
    if (!entry) continue
    const code = entry.slice(0, 2)
    const path = entry.slice(3)
    if (!path.startsWith(prefix)) throw new FileFailure('bad-request')
    const local = path.slice(prefix.length)
    await checkedPath(root, local, true)
    status[local] = code
    if (code.includes('R') || code.includes('C')) i++
    if (++count > FILE_LIMITS.entries) throw new FileFailure('too-large')
  }
  return status
}

export async function loadGitStatus(root: string, prefix: string): Promise<GitStatus> {
  const raw = await safeGit(root, ['status', '--porcelain=v1', '-z', '-uall', '--', '.'])
  const status = await parseGitStatus(root, prefix, raw)
  let branch: string | null = null
  try {
    branch = (await safeGit(root, ['symbolic-ref', '--short', 'HEAD'])).trim()
  } catch {
    /* Detached HEAD. */
  }
  let ahead = 0,
    behind = 0
  // No upstream is a normal local branch, not a query failure.
  let upstream = ''
  try {
    upstream = (
      await safeGit(root, ['rev-parse', '--verify', '--end-of-options', '@{upstream}'])
    ).trim()
  } catch {
    /* No upstream. */
  }
  if (upstream) {
    const counts = (
      await safeGit(root, ['rev-list', '--left-right', '--count', `HEAD...${upstream}`])
    )
      .trim()
      .split(/\s+/)
      .map(Number)
    ahead = counts[0] ?? 0
    behind = counts[1] ?? 0
    if (!Number.isSafeInteger(ahead) || !Number.isSafeInteger(behind) || ahead < 0 || behind < 0)
      throw new FileFailure('internal')
  }
  return { status, branch: branch === 'HEAD' ? null : branch, ahead, behind }
}
