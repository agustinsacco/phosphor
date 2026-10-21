import { FILE_LIMITS, parseFileParams } from '@phosphor/shared/host-protocol-files'
import type { FeatureContext, HostFeature } from './feature'
import { githubReader } from './git/github'
import { loadGitStatus } from './git/status'
import { readGitObject } from './git/show'
import { checkedPath, failure, FileFailure, laneRoot, listedPaths, safeGit } from './files'

function bounded(text: string): string {
  if (Buffer.byteLength(text) > FILE_LIMITS.textBytes) throw new FileFailure('too-large')
  return text
}
export function createGitFeature(context: FeatureContext): HostFeature {
  const prs = githubReader(context)
  return {
    capability: 'workspaces.read',
    methods: ['git.status', 'git.diff', 'git.show', 'github.prs'],
    async call(method, params) {
      if (method === 'github.prs') return prs(params)
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
        if (method === 'git.show')
          return { ok: true, data: await readGitObject(root, prefix, p.path, p.ref) }
        return { ok: true, data: await loadGitStatus(root, prefix) }
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
