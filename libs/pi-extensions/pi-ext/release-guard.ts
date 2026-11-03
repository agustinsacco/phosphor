/**
 * A guard against the release lane's own mistakes, not a security boundary:
 * merges go through release_merge, which checks the lease, and nothing is
 * force-pushed, deleted or pushed straight to the base branch. It splits the
 * command as a shell would, closely enough to see what runs, so quoted text
 * is not a command while `sh -c`, `eval`, `$(…)` and wrappers such as `env`
 * or `timeout` are looked into. A script file or an alias still gets past it.
 */

const MERGE_REFUSAL =
  'Merge with release_merge: it checks this lane still holds the release lease and pins the head you reviewed.'
const PUSH_REFUSAL =
  "The release manager never force-pushes, deletes branches or pushes to the base branch. Push a merge commit to the pull request's branch instead."

const MAX_DEPTH = 4
const ASSIGNMENT = /^[A-Za-z_]\w*=/
const REDIRECT = /^\d*[<>]/
const KEYWORDS = new Set(['!', '{', '}', 'if', 'then', 'elif', 'else', 'while', 'until', 'do'])
const SHELLS = new Set(['sh', 'bash', 'zsh', 'dash', 'ksh'])
/** Commands that run the command after them, with their options that take a value. */
const WRAPPERS = new Map<string, string[]>([
  ['env', ['-u', '-C', '-S', '--unset', '--chdir']],
  ['command', []],
  ['exec', ['-a']],
  ['nohup', []],
  ['nice', ['-n', '--adjustment']],
  ['time', ['-f', '-o', '--format', '--output']],
  ['timeout', ['-s', '-k', '--signal', '--kill-after']],
  ['xargs', ['-I', '-n', '-P', '-L', '-d', '-s', '-a', '-E']],
  ['sudo', ['-u', '-g', '-h', '-p', '-C', '-U']],
])
const GIT_VALUE = new Set(['-C', '-c', '--git-dir', '--work-tree', '--namespace', '--config-env'])
const PUSH_VALUE = new Set(['-o', '--push-option', '--repo', '--receive-pack', '--exec'])
const PUSH_REWRITES = /^--(force|mirror|prune|delete|all|branches)/
const GH_VALUE = new Set(['-R', '--repo'])
const API_VALUE = new Set([
  ...['-X', '--method', '-f', '-F', '--field', '--raw-field', '--input'],
  ...['-H', '--header', '-q', '--jq', '-t', '--template', '--hostname', '-p', '--preview'],
  '--cache',
])
const API_FIELDS = new Set(['-f', '-F', '--field', '--raw-field', '--input'])
const MUTATIONS = /\b(mergePullRequest|enablePullRequestAutoMerge|mergeBranch)\b/

const program = (word: string) => word.slice(word.lastIndexOf('/') + 1)

interface Parsed {
  /** Simple commands, as lists of words with their quotes removed. */
  commands: string[][]
  /** Scripts that `$(…)` and backticks run. */
  nested: string[]
}

/** The index of the `)` closing a `$(` whose body starts at `from`. */
function closing(script: string, from: number): number {
  let depth = 1
  let quote = ''
  for (let i = from; i < script.length; i++) {
    const c = script[i]
    if (quote) {
      if (c === quote) quote = ''
      else if (c === '\\' && quote === '"') i++
    } else if (c === "'" || c === '"') quote = c
    else if (c === '\\') i++
    else if (c === '(') depth++
    else if (c === ')' && --depth === 0) return i
  }
  return script.length
}

/** The index of the closing backtick, collecting the script it runs. */
function backticks(script: string, from: number, nested: string[]): number {
  let body = ''
  let i = from
  for (; i < script.length && script[i] !== '`'; i++) {
    if (script[i] === '\\' && i + 1 < script.length) i++
    body += script[i]
  }
  nested.push(body)
  return i
}

/** Read a double-quoted string from `from`; returns the index of its closing quote. */
function doubleQuoted(script: string, from: number, add: (text: string) => void, nested: string[]) {
  let i = from
  for (; i < script.length && script[i] !== '"'; i++) {
    const c = script[i]!
    if (c === '\\' && '"\\$`\n'.includes(script[i + 1] ?? '')) {
      i++
      if (script[i] !== '\n') add(script[i]!)
    } else if (c === '`') i = backticks(script, i + 1, nested)
    else if (c === '$' && script[i + 1] === '(') {
      const end = closing(script, i + 2)
      nested.push(script.slice(i + 2, end))
      i = end
    } else add(c)
  }
  return i
}

function split(script: string): Parsed {
  const parsed: Parsed = { commands: [], nested: [] }
  const s = { word: null as string | null, words: [] as string[] }
  const add = (text: string) => (s.word = (s.word ?? '') + text)
  const end = () => {
    if (s.word !== null) s.words.push(s.word)
    s.word = null
  }
  const next = () => {
    end()
    if (s.words.length) parsed.commands.push(s.words)
    s.words = []
  }
  for (let i = 0; i < script.length; i++) {
    const c = script[i]!
    if (c === '\\') {
      i++
      if (i < script.length && script[i] !== '\n') add(script[i]!)
    } else if (c === "'") {
      const close = script.indexOf("'", i + 1)
      const stop = close < 0 ? script.length : close
      add(script.slice(i + 1, stop))
      i = stop
    } else if (c === '"') {
      add('')
      i = doubleQuoted(script, i + 1, add, parsed.nested)
    } else if (c === '`') i = backticks(script, i + 1, parsed.nested)
    else if (c === '$' && script[i + 1] === '(') {
      const close = closing(script, i + 2)
      parsed.nested.push(script.slice(i + 2, close))
      i = close
    } else if (c === ' ' || c === '\t') end()
    else if (c === '&' && s.word?.endsWith('>')) add(c)
    else if ('\n;&|'.includes(c) || ((c === '(' || c === ')') && s.word === null)) next()
    else add(c)
  }
  next()
  return parsed
}

/** The command a wrapper runs: `env X=1 timeout 60 gh …` is `gh …`. */
function unwrap(words: string[]): string[] {
  let i = 0
  while (i < words.length) {
    const word = words[i]!
    if (ASSIGNMENT.test(word) || KEYWORDS.has(word)) {
      i++
      continue
    }
    const name = program(word)
    const options = WRAPPERS.get(name)
    if (!options) break
    i++
    while (i < words.length && (words[i]!.startsWith('-') || ASSIGNMENT.test(words[i]!)))
      i += options.includes(words[i]!) ? 2 : 1
    if (name === 'timeout') i++ // The duration.
  }
  return words.slice(i)
}

/** The script a shell or `eval` runs, if this command is one. */
function inner(words: string[]): string | undefined {
  const name = program(words[0] ?? '')
  if (name === 'eval') return words.slice(1).join(' ')
  if (!SHELLS.has(name)) return undefined
  for (let i = 1; i < words.length; i++) {
    const word = words[i]!
    if (word === '-o' || word === '+o') i++
    else if (!word.startsWith('-') && !word.startsWith('+')) return undefined
    else if (/^-[a-z]*c[a-z]*$/i.test(word)) return words[i + 1]
  }
  return undefined
}

function pushRefusal(args: string[], base: string): boolean {
  const positional: string[] = []
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    if (PUSH_VALUE.has(arg)) i++
    else if (arg.startsWith('--')) {
      if (PUSH_REWRITES.test(arg)) return true
    } else if (arg.startsWith('-') && arg.length > 1) {
      if (/[fd]/.test(arg.slice(1))) return true
    } else if (!REDIRECT.test(arg)) positional.push(arg)
  }
  // The first is the remote; each refspec after it names its destination last.
  return positional.slice(1).some((spec) => {
    if (spec.startsWith('+') || spec.startsWith(':')) return true
    return spec.slice(spec.lastIndexOf(':') + 1).replace(/^refs\/heads\//, '') === base
  })
}

function gitRefusal(args: string[], base: string): string | undefined {
  let i = 0
  while (i < args.length && args[i]!.startsWith('-')) i += GIT_VALUE.has(args[i]!) ? 2 : 1
  return args[i] === 'push' && pushRefusal(args.slice(i + 1), base) ? PUSH_REFUSAL : undefined
}

/** `gh api`: a merge endpoint written to, or a GraphQL merge mutation. */
function apiRefusal(args: string[]): string | undefined {
  let method: string | undefined
  let fields = false
  let endpoint: string | undefined
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!
    const eq = arg.startsWith('--') ? arg.indexOf('=') : -1
    const glued = /^-[XfF]./.test(arg)
    const flag = eq > 0 ? arg.slice(0, eq) : glued ? arg.slice(0, 2) : arg
    if (API_VALUE.has(flag)) {
      const value = eq > 0 ? arg.slice(eq + 1) : glued ? arg.slice(2) : (args[++i] ?? '')
      if (flag === '-X' || flag === '--method') method = value.toUpperCase()
      if (API_FIELDS.has(flag)) fields = true
    } else if (!arg.startsWith('-') && endpoint === undefined) endpoint = arg
  }
  if (endpoint === 'graphql')
    return args.some((arg) => MUTATIONS.test(arg)) ? MERGE_REFUSAL : undefined
  const path = (endpoint ?? '').split('?')[0]!.replace(/\/+$/, '')
  const writes = (method ?? (fields ? 'POST' : 'GET')) !== 'GET'
  return writes && /(^|\/)(pulls\/\d+\/merge|merges)$/.test(path) ? MERGE_REFUSAL : undefined
}

function ghRefusal(args: string[]): string | undefined {
  const words: string[] = []
  for (let i = 0; i < args.length && words.length < 2; i++) {
    if (GH_VALUE.has(args[i]!)) i++
    else if (!args[i]!.startsWith('-')) words.push(args[i]!)
  }
  if (words[0] === 'pr' && words[1] === 'merge') return MERGE_REFUSAL
  return words[0] === 'api' ? apiRefusal(args.slice(args.indexOf('api') + 1)) : undefined
}

function check(script: string, base: string, depth: number): string | undefined {
  if (depth > MAX_DEPTH) return undefined
  const { commands, nested } = split(script)
  for (const body of nested) {
    const reason = check(body, base, depth + 1)
    if (reason) return reason
  }
  for (const raw of commands) {
    const words = unwrap(raw)
    const body = inner(words)
    const name = program(words[0] ?? '')
    const reason =
      body !== undefined
        ? check(body, base, depth + 1)
        : name === 'git'
          ? gitRefusal(words.slice(1), base)
          : name === 'gh'
            ? ghRefusal(words.slice(1))
            : undefined
    if (reason) return reason
  }
  return undefined
}

/** Why the release lane may not run this bash command, or undefined when it may. */
export function releaseBashRefusal(command: string, base = 'main'): string | undefined {
  return check(command, base, 0)
}
