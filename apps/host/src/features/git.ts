import { FILE_LIMITS, parseFileParams } from '@phosphor/shared/host-protocol-files'
import type { FeatureContext, HostFeature } from './feature'
import {
  checkedPath,
  failure,
  FileFailure,
  laneRoot,
  listedPaths,
  readResult,
  safeGit,
} from './files'

function bounded(text: string): string {
  if (Buffer.byteLength(text) > FILE_LIMITS.textBytes) throw new FileFailure('too-large')
  return text
}
export function createGitFeature(context: FeatureContext): HostFeature {
  return {
    capability: 'workspaces.read',
    methods: ['git.status', 'git.diff', 'git.show'],
    async call(method, params) {
      const p = parseFileParams(method, params)
      if (!p || !p.laneId || !['git.status', 'git.diff', 'git.show'].includes(method))
        return failure(new FileFailure('bad-request'))
      try {
        const root = await laneRoot(context, p.laneId)
        if (p.path) await checkedPath(root, p.path, true)
        if (method !== 'git.show') await listedPaths(root, p.path ?? '.')
        if (method === 'git.diff') {
          const diff = bounded(
            await safeGit(
              root,
              [
                'diff',
                '--no-ext-diff',
                '--no-textconv',
                '--relative',
                ...(p.staged ? ['--cached'] : []),
                '--',
                p.path ?? '.',
              ],
              FILE_LIMITS.textBytes,
            ),
          )
          return { ok: true, data: { diff } }
        }
        const prefix = (await safeGit(root, ['rev-parse', '--show-prefix'])).trimEnd()
        if (method === 'git.show') {
          if (!p.path || !p.ref) throw new FileFailure('bad-request')
          const tree = (
            await safeGit(root, ['rev-parse', '--verify', '--end-of-options', `${p.ref}^{tree}`])
          ).trim()
          const path = prefix + p.path
          const listing = await safeGit(root, ['ls-tree', '--full-tree', '-z', tree, '--', path])
          const entry = listing.split('\0').find((s) => s.slice(s.indexOf('\t') + 1) === path)
          if (!entry) throw new FileFailure('bad-request')
          const [mode, type, object] = entry.slice(0, entry.indexOf('\t')).split(' ')
          if (!object || type !== 'blob' || !['100644', '100755'].includes(mode ?? ''))
            throw new FileFailure('bad-request')
          const size = Number((await safeGit(root, ['cat-file', '-s', object])).trim())
          if (!Number.isSafeInteger(size) || size < 0) throw new FileFailure('internal')
          // The shared runner has its own 64 MiB buffer cap; avoid materializing oversized blobs.
          if (size > FILE_LIMITS.textBytes) throw new FileFailure('too-large')
          const content = await safeGit(root, ['cat-file', 'blob', object], FILE_LIMITS.textBytes)
          return { ok: true, data: readResult(Buffer.from(content), size) }
        }
        const raw = await safeGit(root, ['status', '--porcelain=v1', '-z', '-uall', '--', '.'])
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
          if (
            !Number.isSafeInteger(ahead) ||
            !Number.isSafeInteger(behind) ||
            ahead < 0 ||
            behind < 0
          )
            throw new FileFailure('internal')
        }
        return {
          ok: true,
          data: { status, branch: branch === 'HEAD' ? null : branch, ahead, behind },
        }
      } catch (error) {
        const result = failure(error)
        context.log('feature-query', {
          laneId: p.laneId,
          method,
          reason: result.ok ? 'ok' : result.error.code,
        })
        return result
      }
    },
  }
}
