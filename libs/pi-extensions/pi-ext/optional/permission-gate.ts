/**
 * Opt-in global gate. Copy this file to ~/.pi/agent/extensions/permission-gate.ts.
 * Not loaded by Phosphor. This is a confirmation heuristic, not a shell sandbox.
 *
 * It judges what the shell would RUN, not the text of the script. A heredoc
 * written to a file, a quoted argument, a comment or `os.kill` inside Python
 * never prompts; `$(…)`, backticks, `bash -c`, `eval`, `trap`, `ssh`,
 * `find -exec`, `xargs` and heredocs fed to a shell are judged like any other
 * command. A script the lexer cannot follow falls back to matching the raw
 * text, so a parser gap costs a prompt, never a pass.
 *
 * Nothing is refused outright: every finding is a question for the user.
 * AWS authorization belongs to this machine's credentials and IAM policy, and
 * no command (scratch cleanup included) exempts the rest of a shell script.
 * A linked-worktree session may recursively delete literal descendants of its
 * lane, or of a pi-scratch job, without asking. Root/outside paths and
 * unresolved shell targets ask.
 */

import { execFileSync } from 'node:child_process'
import { lstatSync, realpathSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path'

interface LaneScope {
  root: string
  /** Unknown after a shell cwd change; absolute targets can still be checked. */
  cwd?: string
}

/** Detect a linked worktree, never grant the main checkout or a home/root cwd. */
function laneScope(cwd?: string): LaneScope | undefined {
  if (!cwd) return undefined
  try {
    const [top, gitDir, common] = execFileSync(
      'git',
      ['rev-parse', '--show-toplevel', '--absolute-git-dir', '--git-common-dir'],
      { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 1000 },
    )
      .trim()
      .split('\n')
    if (!top || !gitDir || !common || resolve(cwd, common) === resolve(gitDir)) return
    const root = realpathSync(top)
    const current = realpathSync(cwd)
    if (root === dirname(root) || root === realpathSync(homedir())) return
    if (current !== root && !current.startsWith(root + sep)) return
    return { root, cwd: current }
  } catch {
    return undefined
  }
}

/** Resolve the existing ancestor too, so missing files do not hide symlink escapes. */
function canonicalTarget(path: string): string | undefined {
  let ancestor = path
  while (true) {
    try {
      lstatSync(ancestor)
      return resolve(realpathSync(ancestor), relative(ancestor, path))
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') return
      // A dangling symlink exists but has no realpath. Do not walk past it.
      try {
        lstatSync(ancestor)
        return undefined
      } catch {
        if (ancestor === dirname(ancestor)) return
        ancestor = dirname(ancestor)
      }
    }
  }
}

function inLane({ text, dynamic }: Word, scope: LaneScope): boolean {
  if (dynamic || /[*?[\]{}~]/.test(text) || text.split('/').includes('..')) return false
  if (!text || (!isAbsolute(text) && !scope.cwd)) return false
  const target = canonicalTarget(resolve(scope.cwd ?? scope.root, text))
  // The lane root itself still asks. Only its descendants are unasked.
  return !!target && target.startsWith(scope.root + sep)
}

/** A pi-scratch job (`~/.pi/agent/scratch/job-<32 hex>`) or a path inside one. */
function inScratchJob({ text, dynamic }: Word): boolean {
  if (dynamic || /[*?[\]{}]/.test(text) || text.split('/').includes('..')) return false
  const home = homedir()
  const path = text.startsWith('~/') ? home + text.slice(1) : text
  if (!isAbsolute(path)) return false
  try {
    const root = resolve(home, '.pi', 'agent', 'scratch')
    // pi-scratch.py refuses a symlinked root; so does this.
    if (lstatSync(root).isSymbolicLink()) return false
    const target = canonicalTarget(resolve(path))
    if (!target) return false
    const job = relative(realpathSync(root), target).split(sep)[0] ?? ''
    return /^job-[0-9a-f]{32}$/.test(job)
  } catch {
    return false
  }
}

interface Word {
  /** The word after quote removal. Expansions are kept as written. */
  text: string
  /** Holds an expansion (`$x`, `$(…)`, backticks) whose value is unknown here. */
  dynamic: boolean
}

interface Parsed {
  commands: Word[][]
  /** Shell source that also runs: backticks, heredocs and herestrings fed to a shell. */
  scripts: string[]
}

class ParseError extends Error {}

const MAX_DEPTH = 8
const SHELLS = new Set(['bash', 'sh', 'zsh', 'dash', 'ksh'])
const ASSIGNMENT = /^[A-Za-z_]\w*(\[[^\]]*\])?\+?=/
const RESERVED = new Set(
  '! { } if then else elif fi do done while until time function coproc'.split(' '),
)
/** Loop and case headers: the words after them are data, not a command. */
const HEADERS = new Set(['for', 'case', 'select', 'in', 'esac'])
/** Commands that run their arguments, with the options that take a value. */
const WRAPPERS: Record<string, Set<string>> = {
  env: new Set(['-u', '-C', '-S', '--unset', '--chdir', '--split-string']),
  command: new Set(),
  builtin: new Set(),
  exec: new Set(['-a']),
  nohup: new Set(),
  nice: new Set(['-n', '--adjustment']),
  timeout: new Set(['-s', '-k', '--signal', '--kill-after']),
  xargs: new Set(['-I', '-d', '-E', '-L', '-n', '-P', '-s', '-a']),
  caffeinate: new Set(['-t', '-w']),
  stdbuf: new Set(),
}
/** Recursive deletes here are this task's own leftovers. `/tmp/*` is not. */
const TEMP_ROOTS = '/tmp/ /private/tmp/ /var/folders/ /private/var/folders/ ~/.pi/agent/scratch/'
/** Directory names that are regenerated by a build or install. */
const BUILD_OUTPUT = new Set(
  'node_modules dist build out coverage .cache test-results playwright-report .vite .next .turbo __pycache__ .pytest_cache .mypy_cache .ruff_cache'.split(
    ' ',
  ),
)

/** Used only when the lexer gives up: the previous whole-text patterns. */
const RAW_PATTERNS: Array<[string, RegExp]> = [
  ['shred', /\bshred\b/i],
  ['truncate', /\btruncate\b/i],
  ['rm -r', /\brm\s+(-rf?|-r|--recursive|--force)/i],
  ['sudo', /\bsudo\b/i],
  ['su', /\bsu\b/i],
  ['git push --force', /\bgit\s+push\s+--force(?!-with-lease)/i],
  ['git reset --hard', /\bgit\s+reset\s+--hard/i],
  ['kill', /\b(kill|pkill|killall)\b/i],
  ['chmod 777', /\b(chmod|chown)\b.*777/i],
  ['systemctl', /\bsystemctl\s+(start|stop|restart|enable|disable)/i],
  ['service', /\bservice\s+\S+\s+(start|stop|restart)/i],
]

/**
 * Split shell source into simple commands, following bash's quoting,
 * heredoc and substitution rules closely enough to know what runs. Inside
 * `$(…)` it calls itself and returns at the closing paren.
 */
function lex(src: string, start: number, nested: boolean, depth: number): Parsed & { end: number } {
  if (depth > MAX_DEPTH) throw new ParseError()
  const commands: Word[][] = []
  const scripts: string[] = []
  let words: Word[] = []
  let line: Word[][] = []
  let stdin: string[] = []
  let heredocs: Array<{ delimiter: string; strip: boolean; expand: boolean }> = []
  let text = ''
  let dynamic = false
  let inWord = false
  let target: 'word' | 'redirect' | 'herestring' = 'word'
  let parens = 0
  let i = start

  const merge = (inner: Parsed): void => {
    commands.push(...inner.commands)
    scripts.push(...inner.scripts)
  }
  // `at` is the index of an opening paren; returns the index past its close.
  const substitute = (at: number): number => {
    if (src[at + 1] === '(') {
      // Arithmetic: not a command, but a `$(…)` inside it still runs.
      let open = 0
      for (let j = at; j < src.length; j++) {
        if (src[j] === '(') open++
        else if (src[j] === ')' && --open === 0) {
          merge(bodyExpansions(src.slice(at + 2, j - 1), depth + 1))
          return j + 1
        }
      }
      throw new ParseError()
    }
    const inner = lex(src, at + 1, true, depth + 1)
    merge(inner)
    return inner.end
  }
  const backtick = (at: number): number => {
    let j = at + 1
    while (j < src.length && src[j] !== '`') j += src[j] === '\\' ? 2 : 1
    if (j >= src.length) throw new ParseError()
    scripts.push(src.slice(at + 1, j).replace(/\\([`$\\])/g, '$1'))
    return j + 1
  }
  const expansion = (at: number): number => {
    const end = src[at] === '`' ? backtick(at) : substitute(at + 1)
    text += src.slice(at, end)
    dynamic = inWord = true
    return end
  }
  const endWord = (): void => {
    if (inWord && target === 'herestring') stdin.push(text)
    else if (inWord && target === 'word') words.push({ text, dynamic })
    if (inWord) target = 'word'
    text = ''
    dynamic = inWord = false
  }
  const endCommand = (): void => {
    endWord()
    if (words.length > 0) {
      commands.push(words)
      line.push(words)
    }
    words = []
  }
  const endLine = (from: number): number => {
    endCommand()
    let j = from
    for (const doc of heredocs) {
      let body = ''
      while (j < src.length) {
        const nl = src.indexOf('\n', j)
        const row = src.slice(j, nl < 0 ? src.length : nl)
        j = nl < 0 ? src.length : nl + 1
        if ((doc.strip ? row.replace(/^\t+/, '') : row) === doc.delimiter) break
        body += `${row}\n`
      }
      if (doc.expand) merge(bodyExpansions(body, depth + 1))
      stdin.push(body)
    }
    if (line.some(readsScriptFromStdin)) scripts.push(...stdin)
    heredocs = []
    line = []
    stdin = []
    return j
  }
  const heredoc = (from: number): number => {
    let j = from
    const strip = src[j] === '-'
    if (strip) j++
    while (src[j] === ' ' || src[j] === '\t') j++
    let delimiter = ''
    let expand = true
    while (j < src.length && !' \t\n;&|<>()'.includes(src[j]!)) {
      const ch = src[j]!
      if (ch === "'" || ch === '"') {
        const close = src.indexOf(ch, j + 1)
        if (close < 0) throw new ParseError()
        delimiter += src.slice(j + 1, close)
        expand = false
        j = close + 1
      } else if (ch === '\\') {
        delimiter += src[j + 1] ?? ''
        expand = false
        j += 2
      } else {
        delimiter += ch
        j++
      }
    }
    if (!delimiter) throw new ParseError()
    heredocs.push({ delimiter, strip, expand })
    return j
  }
  const doubleQuoted = (from: number): number => {
    let j = from
    inWord = true
    while (j < src.length) {
      const ch = src[j]!
      const after = src[j + 1] ?? ''
      if (ch === '"') return j + 1
      if (ch === '\\') {
        if (after !== '\n') text += '$`"\\'.includes(after) ? after : ch + after
        j += 2
      } else if (ch === '`' || (ch === '$' && after === '(')) {
        j = expansion(j)
      } else {
        if (ch === '$' && /[\w{@*#?$!-]/.test(after)) dynamic = true
        text += ch
        j++
      }
    }
    throw new ParseError()
  }

  while (i < src.length) {
    const c = src[i]!
    const next = src[i + 1] ?? ''
    if (c === '\\') {
      if (next !== '\n') {
        text += next
        inWord = true
      }
      i += 2
    } else if (c === "'") {
      const close = src.indexOf("'", i + 1)
      if (close < 0) throw new ParseError()
      text += src.slice(i + 1, close)
      inWord = true
      i = close + 1
    } else if (c === '"') {
      i = doubleQuoted(i + 1)
    } else if (c === '`' || (c === '$' && next === '(')) {
      i = expansion(i)
    } else if (c === '$') {
      if (/[\w{@*#?$!-]/.test(next)) dynamic = true
      text += c
      inWord = true
      i++
    } else if (c === '#' && !inWord) {
      while (i < src.length && src[i] !== '\n') i++
    } else if (c === ' ' || c === '\t') {
      endWord()
      i++
    } else if (c === '\n') {
      i = endLine(i + 1)
    } else if ((c === '<' || c === '>') && next === '(') {
      i = expansion(i)
    } else if (c === '<' || c === '>') {
      // `2>` names a file descriptor, not an argument.
      if (inWord && /^\d+$/.test(text)) {
        text = ''
        inWord = false
      }
      endWord()
      if (src.startsWith('<<<', i)) {
        target = 'herestring'
        i += 3
      } else if (src.startsWith('<<', i)) {
        i = heredoc(i + 2)
      } else {
        i++
        while (i < src.length && '<>&|'.includes(src[i]!)) i++
        target = 'redirect'
      }
    } else if (c === '&' && next === '>') {
      endWord()
      i += src[i + 2] === '>' ? 3 : 2
      target = 'redirect'
    } else if (c === '(') {
      parens++
      endCommand()
      i++
    } else if (c === ')') {
      i++
      if (parens === 0 && nested) {
        if (heredocs.length > 0) throw new ParseError()
        endLine(i)
        return { end: i, commands, scripts }
      }
      endCommand()
      parens = Math.max(0, parens - 1)
    } else if (c === ';' || c === '&' || c === '|') {
      endCommand()
      i++
    } else {
      text += c
      inWord = true
      i++
    }
  }
  if (nested) throw new ParseError()
  endLine(i)
  return { end: i, commands, scripts }
}

/** `$(…)` and backticks in an unquoted heredoc body run when the heredoc is read. */
function bodyExpansions(body: string, depth: number): Parsed {
  const out: Parsed = { commands: [], scripts: [] }
  for (let j = 0; j < body.length; j++) {
    if (body[j] === '\\') {
      j++
    } else if (body[j] === '`') {
      const close = body.indexOf('`', j + 1)
      if (close < 0) throw new ParseError()
      out.scripts.push(body.slice(j + 1, close))
      j = close
    } else if (body[j] === '$' && body[j + 1] === '(' && body[j + 2] !== '(') {
      const inner = lex(body, j + 2, true, depth)
      out.commands.push(...inner.commands)
      out.scripts.push(...inner.scripts)
      j = inner.end - 1
    }
  }
  return out
}

/** The command a simple command actually runs, past assignments and wrappers. */
function unwrap(words: Word[]): { name: string; args: Word[]; viaXargs: boolean } | null {
  let k = 0
  let viaXargs = false
  while (k < words.length) {
    const text = words[k]!.text
    if (HEADERS.has(text)) return null
    if (RESERVED.has(text) || ASSIGNMENT.test(text)) {
      k++
      continue
    }
    const name = text.slice(text.lastIndexOf('/') + 1).toLowerCase()
    const values = WRAPPERS[name]
    if (!values) return { name, args: words.slice(k + 1), viaXargs }
    // `command -v rm` looks rm up; it does not run it.
    if (name === 'command' && /^-[a-zA-Z]*[vV]/.test(words[k + 1]?.text ?? '')) return null
    viaXargs ||= name === 'xargs'
    k++
    while (k < words.length && /^-./.test(words[k]!.text) && words[k]!.text !== '--') {
      k += values.has(words[k]!.text) ? 2 : 1
    }
    if (words[k]?.text === '--') k++
    if (name === 'timeout') k++
  }
  return null
}

function readsScriptFromStdin(words: Word[]): boolean {
  const command = unwrap(words)
  if (command?.name === 'ssh') {
    // No remote command, or `bash -s`: the remote shell runs what arrives on stdin.
    const remote = sshCommand(command.args).split(/\s+/).filter(Boolean)
    return (
      remote.length === 0 || readsScriptFromStdin(remote.map((text) => ({ text, dynamic: false })))
    )
  }
  return (
    !!command &&
    SHELLS.has(command.name) &&
    !command.args.some((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a.text))
  )
}

function sshCommand(args: Word[]): string {
  let k = 0
  while (k < args.length && args[k]!.text.startsWith('-')) {
    k += /^-[bcDEeFIiJLlmOopQRSWw]$/.test(args[k]!.text) ? 2 : 1
  }
  return args
    .slice(k + 1)
    .map((a) => a.text)
    .join(' ')
}

function underTemp({ text, dynamic }: Word): boolean {
  if (dynamic || text.split('/').includes('..')) return false
  const root = TEMP_ROOTS.split(' ').find((r) => text.startsWith(r))
  return root !== undefined && /[^*?[\]{},]/.test(text.slice(root.length).split('/')[0] ?? '')
}

function disposable(word: Word): boolean {
  if (underTemp(word)) return true
  const { text, dynamic } = word
  if (dynamic || /^[/~]/.test(text) || text.split('/').includes('..')) return false
  return BUILD_OUTPUT.has(text.replace(/\/+$/, '').split('/').pop() ?? '')
}

function recursiveDelete(args: Word[], viaXargs: boolean, scope?: LaneScope | null): boolean {
  let recursive = false
  let options = true
  const targets: Word[] = []
  for (const arg of args) {
    if (options && arg.text === '--') options = false
    else if (options && /^--?[a-zA-Z]/.test(arg.text))
      recursive ||= arg.text === '--recursive' || /^-[a-zA-Z]*[rR]/.test(arg.text)
    else targets.push(arg)
  }
  return (
    recursive &&
    (viaXargs ||
      !targets.every((word) =>
        scope === undefined
          ? disposable(word)
          : !!scope && (inLane(word, scope) || inScratchJob(word)),
      ))
  )
}

function gitFindings(args: Word[]): string[] {
  let k = 0
  while (k < args.length && args[k]!.text.startsWith('-'))
    k += /^-[Cc]$/.test(args[k]!.text) ? 2 : 1
  const [sub, ...rest] = args.slice(k).map((a) => a.text)
  // --force-with-lease is the safe form and passes.
  if (sub === 'push' && rest.some((a) => a === '--force' || /^-[a-zA-Z]*f|^\+./.test(a)))
    return ['git push --force']
  return sub === 'reset' && rest.includes('--hard') ? ['git reset --hard'] : []
}

/** `kill -1`, `kill 0` and negative pids signal every process or a whole group. */
function killsGroup(args: Word[]): boolean {
  const first = args[0]?.text ?? ''
  let k = /^-(s|n|-signal)$/.test(first) ? 2 : first.startsWith('-') && first !== '--' ? 1 : 0
  if (args[k]?.text === '--') k++
  return args.slice(k).some((a) => /^(-\d+|0)$/.test(a.text))
}

/** A `pkill -f` pattern narrow enough to name one task's process: a path, file, flag or port. */
function specific({ text }: Word): boolean {
  return (text.match(/\w/g)?.length ?? 0) >= 6 && /[/=:]|\.\w|\d{3}/.test(text)
}

function broadKill(name: string, args: Word[]): boolean {
  if (args.some((a) => /^(-F|--pidfile)/.test(a.text))) return false
  const full = name === 'pkill' && args.some((a) => /^(-[a-zA-Z]*f[a-zA-Z]*|--full)$/.test(a.text))
  const patterns: Word[] = []
  for (let k = 0; k < args.length; k++) {
    const text = args[k]!.text
    if (/^-[gGPstuUJco]$|^--(signal|parent|group|session|terminal|uid|euid)$/.test(text)) k++
    else if (!text.startsWith('-')) patterns.push(args[k]!)
  }
  return !(full && patterns.length > 0 && patterns.every(specific))
}

function judge(words: Word[], depth: number, scope?: LaneScope | null): string[] {
  const command = unwrap(words)
  if (!command) return []
  const { name, args, viaXargs } = command
  const operands = args.filter((a) => !a.text.startsWith('-'))
  const nested = (script: string, inherit = true): string[] =>
    analyze(script, depth + 1, inherit ? scope : null)
  switch (name) {
    case 'sudo':
    case 'doas':
    case 'su':
    case 'shred':
    case 'truncate':
      return [name]
    case 'rm':
      return recursiveDelete(args, viaXargs, scope) ? ['rm -r'] : []
    case 'git':
      return gitFindings(args)
    case 'kill':
      return killsGroup(args) ? ['kill -1'] : []
    case 'pkill':
    case 'killall':
      return broadKill(name, args) ? [name] : []
    case 'chmod':
    case 'chown':
      if (!args.some((a) => a.text.includes('777'))) return []
      return operands.length > 1 && operands.slice(1).every(underTemp) ? [] : [`${name} 777`]
    case 'systemctl':
      return /^(start|stop|restart|enable|disable)$/.test(operands[0]?.text ?? '') ? [name] : []
    case 'service':
      return /^(start|stop|restart)$/.test(operands[1]?.text ?? '') ? [name] : []
    case 'eval':
      return nested(args.map((a) => a.text).join(' '))
    case 'trap':
      return operands[0] ? nested(operands[0].text, false) : []
    case 'ssh':
      return nested(sshCommand(args), false)
    case 'find': {
      const out: string[] = []
      for (let k = 0; k < args.length; k++) {
        if (!/^-(exec|execdir|ok|okdir)$/.test(args[k]!.text)) continue
        const end = args.findIndex((a, j) => j > k && (a.text === ';' || a.text === '+'))
        const inner = args.slice(k + 1, end < 0 ? undefined : end)
        out.push(
          ...judge(
            inner.map((a) => (a.text === '{}' ? { ...a, dynamic: true } : a)),
            depth,
            null,
          ),
        )
        k = end < 0 ? args.length : end
      }
      return out
    }
    default: {
      if (!SHELLS.has(name)) return []
      const flag = args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a.text))
      return flag >= 0 && args[flag + 1] ? nested(args[flag + 1]!.text) : []
    }
  }
}

/** Known path mutations in child shells can invalidate the parent's path check. */
function mayReshapePaths(parsed: Parsed, depth: number): boolean {
  const nested = (script: string): boolean => {
    try {
      return mayReshapePaths(lex(script, 0, false, depth + 1), depth + 1)
    } catch {
      return true
    }
  }
  return (
    parsed.scripts.some(nested) ||
    parsed.commands.some((words) => {
      const command = unwrap(words)
      if (!command) return false
      if (['ln', 'mv', 'eval', 'source', '.'].includes(command.name)) return true
      if (!SHELLS.has(command.name)) return false
      const flag = command.args.findIndex((a) => /^-[a-zA-Z]*c[a-zA-Z]*$/.test(a.text))
      return flag >= 0 && !!command.args[flag + 1] && nested(command.args[flag + 1]!.text)
    })
  )
}

function analyze(script: string, depth: number, scope?: LaneScope | null): string[] {
  try {
    const parsed = lex(script, 0, false, depth)
    // The lexer flattens subshells/branches. Never guess their resulting cwd.
    // An absolute `cd` back to the original cwd is harmless and very common.
    // Do not authorize against pre-command paths if this script rearranges them.
    if (scope && mayReshapePaths(parsed, depth)) scope = null
    if (
      scope &&
      parsed.commands.some((words) => {
        const command = unwrap(words)
        if (command?.name === 'cd') {
          const args = command.args.filter((a) => a.text !== '--')
          return (
            args.length !== 1 ||
            args[0]!.dynamic ||
            !isAbsolute(args[0]!.text) ||
            args[0]!.text !== scope?.cwd
          )
        }
        return (
          ['pushd', 'popd'].includes(command?.name ?? '') ||
          words.some((a) => /^(-C|--chdir(?:=|$))/.test(a.text))
        )
      })
    )
      scope = { ...scope, cwd: undefined }
    return [
      ...parsed.commands.flatMap((words) => judge(words, depth, scope)),
      ...parsed.scripts.flatMap((source) => analyze(source, depth + 1, scope)),
    ]
  } catch {
    return RAW_PATTERNS.filter(([, pattern]) => pattern.test(script)).map(([label]) => label)
  }
}

/** Why a command needs approval, as short labels. Empty means it runs unasked. */
export function permissionFindings(command: string, cwd?: string): string[] {
  return [...new Set(analyze(command, 0, laneScope(cwd)))]
}

export function permissionDecision(command: string, cwd?: string): 'allow' | 'ask' {
  return permissionFindings(command, cwd).length > 0 ? 'ask' : 'allow'
}

// Structural types keep this standalone file independent of pi's package name.
interface GateContext {
  cwd?: string
  hasUI: boolean
  ui: { select(title: string, options: string[]): Promise<string | undefined> }
}
interface GateApi {
  on(
    event: 'tool_call',
    handler: (
      event: { toolName: string; input: { command?: unknown } },
      ctx: GateContext,
    ) => Promise<{ block: true; reason: string } | undefined>,
  ): void
}

export default function permissionGate(pi: GateApi): void {
  pi.on('tool_call', async (event, ctx) => {
    if (event.toolName !== 'bash') return
    const command = event.input.command
    if (typeof command !== 'string') return { block: true, reason: 'Invalid bash command' }
    const findings = permissionFindings(command, ctx.cwd)
    if (findings.length === 0) return
    // Short on purpose: Phosphor's approval sheet reads this heading line.
    const label = findings.length > 1 ? `${findings[0]} +${findings.length - 1}` : findings[0]
    if (!ctx.hasUI)
      return { block: true, reason: `Command blocked (${label}, no UI to confirm): ${command}` }
    const choice = await ctx.ui.select(`Dangerous command (${label}):\n\n  ${command}\n\nAllow?`, [
      'Yes',
      'No',
    ])
    if (choice !== 'Yes') return { block: true, reason: `Blocked by user (${label}): ${command}` }
  })
}
