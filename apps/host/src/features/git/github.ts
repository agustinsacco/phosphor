import { ghPrsForRepo, type GhRunner } from '@phosphor/session-runtime/git/github'
import { createGithubReader } from '@phosphor/session-runtime/git/github-reader'
import { runGithubCommand } from '@phosphor/session-runtime/git/github-command'
import type { GithubGate } from '@phosphor/session-runtime/git/github-gate'
import {
  parsePrParams,
  parsePrReadOptions,
  parseRepoPrs,
} from '@phosphor/shared/host-protocol-github'
import type { FeatureContext, FeatureOutcome } from '../feature'
import { failure, FileFailure } from '../files'

/** Old clients omit branch interests. Bound their compatibility read by the same deadline. */
async function legacyRead(context: FeatureContext, cwd: string): Promise<FeatureOutcome> {
  const controller = new AbortController()
  const failedSearches = new Set<string>()
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort()
      resolve(null)
    }, 20_000)
    timer.unref()
  })
  try {
    const query = ghPrsForRepo(async (path, args) => {
      if (controller.signal.aborted) return null
      const result = await runGithubCommand(path, args, context.env, controller.signal)
      const search = args.indexOf('--search')
      if (search >= 0) {
        const key = args[search + 1]!
        if (result.ok) failedSearches.delete(key)
        else failedSearches.add(key)
      }
      return result.ok ? result.stdout : null
    }, cwd)
    const result = await Promise.race([query, timeout])
    return { ok: true, data: failedSearches.size ? null : parseRepoPrs(result) }
  } finally {
    clearTimeout(timer)
  }
}

/**
 * One machine-owned reader shared by all clients; no GitHub credentials cross the wire.
 * `gate` is the queue and rate-limit pause it shares with PR status by number.
 */
export function githubReader(context: FeatureContext, gate?: GithubGate) {
  const reader = createGithubReader({
    run: (cwd, args, signal) => runGithubCommand(cwd, args, context.env, signal),
    ...(gate ? { gate } : {}),
  })
  const paths = new Set<string>()
  const legacy = new Map<
    string,
    { at: number; pending: boolean; result: Promise<FeatureOutcome> }
  >()
  return async (params: unknown): Promise<FeatureOutcome> => {
    const id = parsePrParams(params)
    const repositories = context.store.listRepositories()
    for (const path of paths)
      if (!repositories.some((r) => r.path === path)) {
        reader.remove(path)
        paths.delete(path)
        legacy.delete(path)
      }
    const repository = repositories.find((r) => r.id === id)
    if (!repository) return failure(new FileFailure('bad-request'))
    paths.add(repository.path)
    const rawOptions = (params as { options?: unknown }).options
    if (rawOptions !== undefined) {
      const options = parsePrReadOptions(rawOptions)
      if (!options) return failure(new FileFailure('bad-request'))
      return { ok: true, data: parseRepoPrs(await reader.read(repository.path, options)) }
    }
    const cached = legacy.get(repository.path)
    if (cached && (cached.pending || Date.now() - cached.at < 60_000)) return cached.result
    const next = { at: Date.now(), pending: true, result: legacyRead(context, repository.path) }
    legacy.set(repository.path, next)
    next.result = next.result.finally(() => {
      next.at = Date.now()
      next.pending = false
    })
    return next.result
  }
}

/**
 * Read-only gh for lane deletion's merged-PR proof. Each call has `runGithubCommand`'s 8 s
 * timeout; failure is no answer.
 */
export function githubRunner(env: NodeJS.ProcessEnv): GhRunner {
  return async (cwd, args) => {
    const result = await runGithubCommand(cwd, args, env, new AbortController().signal)
    return result.ok ? result.stdout : null
  }
}
