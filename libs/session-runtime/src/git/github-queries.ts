import type { GhPullRequest } from '@phosphor/shared/models'
import { toPullRequest } from './github'
import { GithubFailure, type GithubCommand } from './github-command'

export interface GithubRepository {
  host: string
  name: string
  owner: string
  head: string
}
export interface GithubPr extends GhPullRequest {
  headRefName: string
  headRepository: { nameWithOwner: string } | null
  isDraft?: boolean
  commits?: {
    nodes: {
      commit: {
        statusCheckRollup: {
          contexts: {
            nodes: { status?: string; conclusion?: string; state?: string }[]
            pageInfo: { hasNextPage: boolean }
          }
        } | null
      }
    }[]
  }
}
interface Connection {
  nodes: GithubPr[]
  pageInfo: { hasNextPage: boolean }
}
const IDENTITY = 'number title url state isDraft headRefName headRepository{nameWithOwner}'
const DETAILS = `mergeable mergeStateStatus reviewDecision commits(last:1){nodes{commit{
  statusCheckRollup{contexts(first:100){nodes{... on CheckRun{status conclusion} ... on StatusContext{state}} pageInfo{hasNextPage}}}
}}}`

async function json(run: GithubCommand, cwd: string, args: string[], signal: AbortSignal) {
  const result = await run(cwd, args, signal)
  if (!result.ok) throw new GithubFailure(result.reason, result.retryWithoutChecks)
  return JSON.parse(result.stdout)
}

/** Resolve gh's base repo while retaining origin identity to disambiguate fork heads. */
export async function githubRepository(
  run: GithubCommand,
  cwd: string,
  origin: string | null,
  signal: AbortSignal,
): Promise<GithubRepository> {
  const value = await json(run, cwd, ['repo', 'view', '--json', 'nameWithOwner,url'], signal)
  const url = new URL(value.url)
  const [owner, name, extra] = String(value.nameWithOwner).split('/')
  if (url.protocol !== 'https:' || !owner || !name || extra || url.username || url.password)
    throw new GithubFailure('unavailable')
  let head = `${owner}/${name}`
  if (origin) {
    const remote = new URL(origin.replace(/^(?:[^/@]+@)?([^/:]+):(?=[^/])/, 'https://$1/'))
    if (remote.hostname !== url.hostname) throw new GithubFailure('unavailable')
    head = remote.pathname.replace(/^\//, '').replace(/\.git$/, '')
    if (!/^[\w.-]+\/[\w.-]+$/.test(head)) throw new GithubFailure('unavailable')
  }
  return { host: url.hostname, owner, name, head }
}

async function query(
  run: GithubCommand,
  cwd: string,
  repository: GithubRepository,
  fields: string,
  signal: AbortSignal,
) {
  const q = `query{repository(owner:${JSON.stringify(repository.owner)},name:${JSON.stringify(repository.name)}){${fields}}}`
  const result = await json(
    run,
    cwd,
    ['api', 'graphql', '--hostname', repository.host, '--include', '-f', `query=${q}`],
    signal,
  )
  if (result.errors?.length || !result.data?.repository) throw new GithubFailure('unavailable')
  return result.data.repository
}

/** Exact branch queries, not search prefixes. Open PRs outrank terminal history. */
export async function discoverGithubPrs(
  run: GithubCommand,
  cwd: string,
  repository: GithubRepository,
  branches: string[],
  signal: AbortSignal,
): Promise<Map<string, GithubPr | null>> {
  const fields = branches
    .map((branch, i) => {
      const args = `headRefName:${JSON.stringify(branch)},first:20,orderBy:{field:CREATED_AT,direction:DESC}`
      const selection = `{nodes{${IDENTITY}} pageInfo{hasNextPage}}`
      return `b${i}:pullRequests(${args})${selection} o${i}:pullRequests(${args},states:OPEN)${selection}`
    })
    .join(' ')
  const data = await query(run, cwd, repository, fields, signal)
  const found = new Map<string, GithubPr | null>()
  branches.forEach((branch, i) => {
    const all = data[`b${i}`] as Connection | undefined
    const open = data[`o${i}`] as Connection | undefined
    if (!Array.isArray(all?.nodes) || !Array.isArray(open?.nodes)) return
    const matches = (pr: GithubPr) =>
      pr.headRefName === branch &&
      pr.headRepository?.nameWithOwner.toLowerCase() === repository.head.toLowerCase()
    const live = open.nodes.find(matches)
    // Deleted/inaccessible fork identities cannot establish absence or outrank history safely.
    const unverifiable = (pr: GithubPr) => pr.headRefName === branch && !pr.headRepository
    if (!live && (open.nodes.some(unverifiable) || all.nodes.some(unverifiable))) return
    if (!live && open.pageInfo?.hasNextPage !== false) return
    const candidate = live ?? all.nodes.find(matches)
    if (!candidate && all.pageInfo?.hasNextPage !== false) return
    if (candidate && !toPullRequest(candidate)) return
    found.set(branch, candidate ?? null)
  })
  return found
}

/** Once discovered, refresh canonical PR numbers rather than rediscovering repo history. */
export async function refreshGithubPrs(
  run: GithubCommand,
  cwd: string,
  repository: GithubRepository,
  prs: { branch: string; number: number }[],
  signal: AbortSignal,
): Promise<Map<string, GhPullRequest>> {
  for (const detailed of [true, false]) {
    try {
      const fields = prs
        .map(
          (pr, i) =>
            `p${i}:pullRequest(number:${pr.number}){${IDENTITY} ${detailed ? DETAILS : ''}}`,
        )
        .join(' ')
      const data = await query(run, cwd, repository, fields, signal)
      const result = new Map<string, GhPullRequest>()
      prs.forEach(({ branch }, i) => {
        const raw = data[`p${i}`] as GithubPr | undefined
        if (
          !raw ||
          raw.headRefName !== branch ||
          raw.headRepository?.nameWithOwner.toLowerCase() !== repository.head.toLowerCase()
        )
          return
        const contexts = raw.commits?.nodes[0]?.commit.statusCheckRollup?.contexts
        const pr = toPullRequest({ ...raw, statusCheckRollup: contexts?.nodes })
        if (!pr) return
        if (!detailed || (contexts && contexts.pageInfo?.hasNextPage !== false)) pr.checks = null
        result.set(branch, pr)
      })
      return result
    } catch (error) {
      if (
        !detailed ||
        !(error instanceof GithubFailure) ||
        !error.retryWithoutChecks ||
        signal.aborted
      )
        throw error
    }
  }
  return new Map()
}
