import { runGithubCommand } from '@phosphor/session-runtime/git/github-command'
import { GithubGate } from '@phosphor/session-runtime/git/github-gate'
import { createGithubPrDetailReader } from '@phosphor/session-runtime/git/github-pr-detail'
import { createGithubPrStatusReader } from '@phosphor/session-runtime/git/github-pr-status'
import {
  parsePrDetailParams,
  parsePrSummariesParams,
} from '@phosphor/shared/host-protocol-pr-status'
import type { FeatureContext, FeatureOutcome } from '../feature'
import { failure, FileFailure } from '../files'

/** One queue and one rate-limit pause for every GitHub read this Host makes. */
export const hostGithubGate = (context: FeatureContext): GithubGate =>
  new GithubGate((cwd, args, signal) => runGithubCommand(cwd, args, context.env, signal))

/**
 * `github.prSummaries` and `github.prDetail`: PR status by number on the Host's
 * own gh, the same readers This Mac uses. gh names the GitHub host per call, so
 * it runs in the Host account's home; only hosts a checkout resolved are asked.
 */
export function githubPrStatus(context: FeatureContext, gate: GithubGate) {
  const summaries = createGithubPrStatusReader({ gate, cwd: context.home })
  const detail = createGithubPrDetailReader({ gate, cwd: context.home })
  return {
    async summaries(params: unknown): Promise<FeatureOutcome> {
      const request = parsePrSummariesParams(params)
      if (!request) return failure(new FileFailure('bad-request'))
      return { ok: true, data: await summaries.read(request.refs, request.options) }
    },
    async detail(params: unknown): Promise<FeatureOutcome> {
      const request = parsePrDetailParams(params)
      if (!request) return failure(new FileFailure('bad-request'))
      return { ok: true, data: await detail.read(request.ref, request.options) }
    },
  }
}
