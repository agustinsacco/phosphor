/** Parent lane only. pi owns the session's base; all section edits are request-local. */
const COMMAND = 'phosphor-directives'
const EXTRA = 'phosphor_directives'
const CURRENT = 'PHOSPHOR_DIRECTIVES'

interface DirectiveApi {
  on(event: string, handler: (event: unknown, ctx: unknown) => unknown): void
  registerCommand?(
    name: string,
    command: { description: string; handler(args: string): Promise<void> },
  ): void
  appendEntry?(name: string, data: unknown): void
}

type System = { role?: string; sections?: Record<string, string | null> }
const wrap = (name: string, text: string) => `<${name}>\n${text}\n</${name}>`

function decode(arg: string): string {
  if (arg === '-') return ''
  const text = Buffer.from(arg, 'base64').toString('utf8')
  if (!text || Buffer.from(text).toString('base64') !== arg)
    throw new Error('Expected base64 UTF-8 directives or -.')
  return text
}

/** A nested launch can inherit the outer lane's env. The actual argv identifies this spawn. */
function spawnBase(argv: readonly string[], env: NodeJS.ProcessEnv) {
  const index = argv.indexOf('--append-system-prompt')
  if (index < 0) return undefined
  const arg = argv[index + 1]
  const encoded = env.PHOSPHOR_DIRECTIVES_BASE
  if (encoded && arg && Buffer.from(arg).toString('base64') === encoded) return decode(encoded)
  return arg // A pre-update lane reloaded the extension without the new env key.
}

function override(messages: unknown[], base: string | undefined, current: string) {
  // A resumed branch may establish the fresh spawn base in a later system patch.
  const owned = base && wrap('addendum', base)
  const start = messages.findIndex((m) => (m as System | null)?.role === 'system')
  if (start < 0 || !(messages[start] as System).sections) return undefined
  const match = owned
    ? messages.findIndex(
        (m) =>
          (m as System | null)?.role === 'system' && (m as System).sections?.addendum === owned,
      )
    : -1
  const index = match < 0 ? start : match
  const key = match < 0 ? EXTRA : 'addendum'
  return {
    messages: messages.map((m, i) => {
      const sys = m as System | null
      if (sys?.role !== 'system' || i < index || (i > index && !(key in (sys.sections ?? {}))))
        return m
      const sections = { ...sys.sections }
      if (i === index && current) sections[key] = wrap(key, current)
      else if (i === index && i !== start) sections[key] = null
      else delete sections[key]
      return { ...sys, sections }
    }),
  }
}

export default function directivesExtension(
  pi: DirectiveApi,
  env = process.env,
  argv: readonly string[] = process.argv,
) {
  const base = spawnBase(argv, env)
  // A reload shares process.env, but a new or resumed pi must use its freshly composed base.
  const prefix = `${process.pid}:`
  const saved = env[CURRENT]
  let current = saved?.startsWith(prefix) ? decode(saved.slice(prefix.length)) : undefined
  pi.registerCommand?.(COMMAND, {
    description: 'Host control: replace the lane directives for the next request',
    async handler(args) {
      const arg = args.trim()
      const text = decode(arg)
      pi.appendEntry?.(COMMAND, { text })
      env[CURRENT] = prefix + arg
      current = text
    },
  })
  pi.on('context_with_system', (event) => {
    const messages = (event as { messages?: unknown[] }).messages
    return current === undefined || !Array.isArray(messages)
      ? undefined
      : override(messages, base, current)
  })
  return {
    prompt(prompt: string): string {
      if (current === undefined) return prompt
      const old = base && wrap('addendum', base)
      if (old && prompt.includes(old))
        return prompt.replace(old, () => (current ? wrap('addendum', current) : ''))
      return current ? `${prompt}\n\n${wrap(EXTRA, current)}` : prompt
    },
  }
}
