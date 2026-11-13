import type { GhPrRef } from '@phosphor/shared/models'
import { isPrRef, prRefsIn } from '@phosphor/shared/github-pr-refs'

/**
 * Reading branch and PR intent out of the shell commands a lane ran. Not a
 * shell parser: quotes, escapes and the usual separators, which is what an
 * agent writes. Anything it cannot read yields nothing, never a guess.
 */

const MAX_COMMAND = 64 * 1024
const DEFAULT_BRANCHES = new Set(['main', 'master', 'develop', 'trunk', 'HEAD', 'origin'])

/** Drop heredoc bodies: a PR description that quotes `git push` pushed nothing. */
export function stripHeredocs(command: string): string {
  if (!command.includes('<<')) return command
  const kept: string[] = []
  let end: string | null = null
  for (const line of command.split('\n')) {
    if (end !== null) {
      if (line.trim() === end) end = null
      continue
    }
    kept.push(line)
    const match = /(?<!<)<<(?!<)-?\s*(['"]?)([A-Za-z_][\w-]*)\1/.exec(line)
    if (match) end = match[2]!
  }
  return kept.join('\n')
}

/** Simple commands, split on unquoted separators, as token lists. */
export function commandSegments(command: string): string[][] {
  const text = command.slice(0, MAX_COMMAND)
  const segments: string[][] = []
  let segment: string[] = []
  let token = ''
  let started = false
  let quote: string | null = null
  const word = (): void => {
    if (started) segment.push(token)
    token = ''
    started = false
  }
  const close = (): void => {
    word()
    if (segment.length) segments.push(segment)
    segment = []
  }
  for (let i = 0; i < text.length; i++) {
    const c = text[i]!
    if (quote) {
      if (c === quote) quote = null
      else if (c === '\\' && quote === '"' && i + 1 < text.length) token += text[++i]
      else token += c
      continue
    }
    if (c === "'" || c === '"') {
      quote = c
      started = true
    } else if (c === '\\' && i + 1 < text.length) {
      if (text[i + 1] !== '\n') {
        token += text[i + 1]
        started = true
      }
      i++
    } else if (c === ' ' || c === '\t') word()
    else if ('\n;&|()'.includes(c)) close()
    else {
      token += c
      started = true
    }
  }
  close()
  return segments
}

export function validBranch(name: string): boolean {
  return (
    name.length <= 200 &&
    /^\w[\w./+-]*$/.test(name) &&
    !name.includes('..') &&
    !name.includes('//') &&
    !name.endsWith('/') &&
    !name.endsWith('.') &&
    !name.endsWith('.lock') &&
    !DEFAULT_BRANCHES.has(name)
  )
}

/** The program and its arguments, past `VAR=value` prefixes. */
function program(tokens: string[]): { name: string; args: string[] } | null {
  let i = 0
  while (i < tokens.length && /^[A-Za-z_]\w*=/.test(tokens[i]!)) i++
  const name = tokens[i]?.split('/').pop()
  return name ? { name, args: tokens.slice(i + 1) } : null
}

/** git's own options before the subcommand. */
function gitArgs(args: string[]): string[] {
  let i = 0
  while (i < args.length && args[i]!.startsWith('-'))
    i += args[i] === '-C' || args[i] === '-c' ? 2 : 1
  return args.slice(i)
}

function valueAfter(args: string[], flags: string[]): string | undefined {
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (flags.includes(arg)) return args[i + 1]
    for (const flag of flags)
      if (flag.startsWith('--') && arg.startsWith(`${flag}=`)) return arg.slice(flag.length + 1)
  }
  return undefined
}

const PUSH_VALUE_FLAGS = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec'])

function pushedBranches(args: string[]): string[] {
  if (args.some((arg) => ['--delete', '-d', '--tags', '--all', '--mirror'].includes(arg))) return []
  const positional: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (PUSH_VALUE_FLAGS.has(arg)) i++
    else if (!arg.startsWith('-')) positional.push(arg)
  }
  return positional.slice(1).flatMap((spec) => {
    const refspec = spec.replace(/^\+/, '')
    const colon = refspec.indexOf(':')
    if (colon === 0) return [] // `:branch` deletes it.
    return [(colon > 0 ? refspec.slice(colon + 1) : refspec).replace(/^refs\/heads\//, '')]
  })
}

function created(name: string, args: string[]): string[] {
  if (name === 'gh') {
    if (args[0] !== 'pr' || args[1] !== 'create') return []
    const head = valueAfter(args, ['--head', '-H'])
    return head ? [head.replace(/^[\w.-]+:/, '')] : []
  }
  if (name !== 'git') return []
  const [sub, ...rest] = gitArgs(args)
  if (sub === 'checkout') return [valueAfter(rest, ['-b', '-B']) ?? ''].filter(Boolean)
  if (sub === 'switch')
    return [valueAfter(rest, ['-c', '-C', '--create', '--force-create']) ?? ''].filter(Boolean)
  if (sub === 'worktree' && rest[0] === 'add')
    return [valueAfter(rest, ['-b', '-B']) ?? ''].filter(Boolean)
  if (sub === 'push') return pushedBranches(rest)
  return []
}

/** Branches a command created or pushed. */
export function branchesCreatedBy(command: string): string[] {
  if (!/\bgit\b|\bgh\b/.test(command)) return []
  const found = new Set<string>()
  for (const tokens of commandSegments(command)) {
    const run = program(tokens)
    if (!run) continue
    for (const branch of created(run.name, run.args)) if (validBranch(branch)) found.add(branch)
  }
  return [...found]
}

const REVIEW_COMMANDS = new Set(['checkout', 'diff', 'review', 'comment'])
const GH_VALUE_FLAGS = new Set(['-R', '--repo', '-b', '--body', '-F', '--body-file', '--branch'])

function repoFlag(value: string | undefined): Omit<GhPrRef, 'number'> | null {
  const parts = value?.split('/') ?? []
  const [host, owner, repo] = parts.length === 3 ? parts : ['github.com', ...parts]
  const ref = { host: host!.toLowerCase(), owner: owner!, repo: repo!, number: 1 }
  return parts.length >= 2 && parts.length <= 3 && isPrRef(ref)
    ? { host: ref.host, owner: ref.owner, repo: ref.repo }
    : null
}

/** PRs a command checked out, diffed or reviewed: full refs, or bare numbers. */
export function reviewedBy(command: string): { refs: GhPrRef[]; numbers: number[] } {
  const refs: GhPrRef[] = []
  const numbers: number[] = []
  if (!/\bgh\s+pr\s+(?:checkout|diff|review|comment)\b/.test(command)) return { refs, numbers }
  for (const tokens of commandSegments(command)) {
    const run = program(tokens)
    if (run?.name !== 'gh' || run.args[0] !== 'pr' || !REVIEW_COMMANDS.has(run.args[1] ?? ''))
      continue
    const args = run.args.slice(2)
    let target: string | undefined
    for (let i = 0; i < args.length && !target; i++) {
      if (GH_VALUE_FLAGS.has(args[i]!)) i++
      else if (!args[i]!.startsWith('-')) target = args[i]
    }
    if (!target) continue
    const url = prRefsIn(target, 1)[0]
    if (url) refs.push(url)
    else if (/^\d{1,9}$/.test(target)) {
      const repo = repoFlag(valueAfter(args, ['-R', '--repo']))
      if (repo) refs.push({ ...repo, number: Number(target) })
      else numbers.push(Number(target))
    }
  }
  return { refs, numbers }
}
