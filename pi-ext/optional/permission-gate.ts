/** Opt-in global gate. Copy this file to ~/.pi/agent/extensions/permission-gate.ts.
 * Not loaded by Phosphor. This is a confirmation heuristic, not a shell sandbox.
 */
const ALWAYS_BLOCKED = [/\bshred\b/i, /\btruncate\b/i]
const DANGEROUS_PATTERNS = [
  /\brm\s+(-rf?|-r|--recursive|--force)/i,
  /\bsudo\b/i,
  /\bsu\b/i,
  /\bgit\s+push\s+--force/i,
  /\bgit\s+reset\s+--hard/i,
  /\bkill\b/i,
  /\bpkill\b/i,
  /\bkillall\b/i,
  /\b(chmod|chown)\b.*777/i,
  /\bsystemctl\s+(start|stop|restart|enable|disable)/i,
  /\bservice\s+\S+\s+(start|stop|restart)/i,
]

interface Word {
  value: string
  start: number
  end: number
}

/** Recognize only literal simple commands. Unsupported syntax keeps the prompt.
 * Quoted heredocs are skipped as data, but never exempted from the AWS regex.
 * No expansion, escaping, functions, subshells, or shell evaluation is inferred.
 */
function literalCommands(source: string): Word[][] | null {
  const commands: Word[][] = []
  let words: Word[] = []
  let heredoc: string | undefined
  const word = /(?:[^\s;&|<>(){}'"\\`$#*?[\]~!]+|'[^']*'|"[^"$`\\]*")+/y
  for (let i = 0; i < source.length;) {
    const char = source[i]!
    if (/[ \t\r]/.test(char)) {
      i++
      continue
    }
    if (/[\n;&|]/.test(char)) {
      commands.push(words)
      words = []
      i++
      if (char === '\n' && heredoc) {
        const end = new RegExp(`^${heredoc}\\r?$`, 'm').exec(source.slice(i))
        if (!end) return null
        i += end.index + end[0].length
        heredoc = undefined
      }
      continue
    }
    if (source.startsWith('<<', i)) {
      // One literal, quoted heredoc per command is sufficient for Python readers.
      const match = /^<<[ \t]*'([A-Za-z_][A-Za-z0-9_]*)'/.exec(source.slice(i))
      if (!match || heredoc) return null
      heredoc = match[1]!
      words.push({ value: '<<', start: i, end: i + match[0].length })
      i += match[0].length
      continue
    }
    if (char === '>') {
      words.push({ value: '>', start: i, end: ++i })
      continue
    }
    word.lastIndex = i
    const match = word.exec(source)
    if (!match) return null
    words.push({
      value: match[0].replace(/'([^']*)'|"([^"]*)"/g, (_all, single, double) => single ?? double),
      start: i,
      end: word.lastIndex,
    })
    i = word.lastIndex
  }
  if (heredoc) return null
  commands.push(words)
  return commands
}

function localS3Read(words: Word[]): Word | undefined {
  const args = words.map((word) => word.value)
  if (args.slice(0, 3).join(' ') !== 'env -u AWS_PROFILE') return
  const credentials = args.slice(3, 6).sort()
  if (
    credentials.join(' ') !==
    'AWS_ACCESS_KEY_ID=test AWS_DEFAULT_REGION=us-east-1 AWS_SECRET_ACCESS_KEY=test'
  )
    return
  if (args[6] !== 'aws') return
  let index = 7
  if (args[index] !== '--endpoint-url' && !args[index]?.startsWith('--endpoint-url=')) return
  const endpoint =
    args[index] === '--endpoint-url' ? args[++index] : args[index]?.replace(/^--endpoint-url=/, '')
  if (!/^http:\/\/(localhost|127\.0\.0\.1):4566$/.test(endpoint ?? '')) return
  index++
  const service = args[index++]
  const operation = args[index++]
  const listing = service === 's3api' && operation === 'list-objects-v2'
  const download = service === 's3' && operation === 'cp'
  if (!listing && !download) return
  if (download) {
    // No uploads, bucket-to-bucket copies, access-point ARNs, or remote URLs.
    if (!/^s3:\/\/[a-z0-9-]+\/.+/.test(args[index++] ?? '') || args[index++] !== '-') return
  }
  const values = listing
    ? new Set(['--bucket', '--prefix', '--query', '--output', '--max-keys', '--continuation-token'])
    : new Set(['--query', '--output'])
  const seen = new Set<string>()
  while (index < args.length) {
    const option = args[index++]!
    if (option === '>' && index === args.length - 1 && /^\/tmp\/[\w.-]+$/.test(args[index]!)) {
      index++
      continue
    }
    if (seen.has(option)) return
    seen.add(option)
    if (download && option === '--only-show-errors') continue
    if (!values.has(option)) return // Includes profile/endpoint overrides and abbreviations.
    const value = args[index++]
    if (!value || value.startsWith('-') || /(?:file|https?):\/\//.test(value)) return
    if (option === '--bucket' && !/^[a-z0-9-]+$/.test(value)) return
  }
  if (listing && !seen.has('--bucket')) return
  return words[6]
}

export function permissionDecision(command: string): 'allow' | 'ask' | 'block' {
  if (ALWAYS_BLOCKED.some((pattern) => pattern.test(command))) return 'block'
  if (DANGEROUS_PATTERNS.some((pattern) => pattern.test(command))) return 'ask'
  // Remove only independently verified AWS tokens, never whole commands/scripts.
  const exempt = (literalCommands(command) ?? []).flatMap((words) => {
    const aws = localS3Read(words)
    return aws ? [aws] : []
  })
  let remaining = command
  for (const word of exempt.reverse()) {
    remaining =
      remaining.slice(0, word.start) + ' '.repeat(word.end - word.start) + remaining.slice(word.end)
  }
  return /\baws\s+/i.test(remaining) ? 'ask' : 'allow'
}

// Structural types keep this standalone file independent of pi's package name.
interface GateContext {
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
    const decision = permissionDecision(command)
    if (decision === 'block') return { block: true, reason: `Command blocked: ${command}` }
    if (decision === 'allow') return
    if (!ctx.hasUI)
      return { block: true, reason: `Command blocked (no UI for confirmation): ${command}` }
    const choice = await ctx.ui.select(`Dangerous command:\n\n  ${command}\n\nAllow?`, [
      'Yes',
      'No',
    ])
    if (choice !== 'Yes') return { block: true, reason: `Blocked by user: ${command}` }
  })
}
