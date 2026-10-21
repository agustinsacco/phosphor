import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ghPrsForRepo } from '@phosphor/session-runtime/git/github'
import { parsePrParams, parseRepoPrs } from '@phosphor/shared/host-protocol-github'
import type { FeatureContext, FeatureOutcome } from '../feature'
import { failure, FileFailure } from '../files'

const exec = promisify(execFile)
/** One bounded read per configured repository, shared across all clients and lanes. */
export function githubReader(context: FeatureContext) {
  const cache = new Map<string, { at: number; result: Promise<FeatureOutcome> }>()
  return async (params: unknown): Promise<FeatureOutcome> => {
    const id = parsePrParams(params)
    const repository = context.store.listRepositories().find((r) => r.id === id)
    if (!repository) return failure(new FileFailure('bad-request'))
    for (const key of cache.keys()) {
      if (!context.store.listRepositories().some((r) => r.path === key)) cache.delete(key)
    }
    const cached = cache.get(repository.path)
    if (cached && Date.now() - cached.at < 60_000) return cached.result
    const result = ghPrsForRepo(async (cwd, args) => {
      try {
        const { stdout } = await exec('gh', args, {
          cwd,
          timeout: 15_000,
          maxBuffer: 8 * 1024 * 1024,
          env: { ...context.env, GH_PROMPT_DISABLED: '1', GH_NO_UPDATE_NOTIFIER: '1' },
        })
        return stdout
      } catch {
        return null
      }
    }, repository.path).then((data): FeatureOutcome => ({ ok: true, data: parseRepoPrs(data) }))
    cache.set(repository.path, { at: Date.now(), result })
    return result
  }
}
