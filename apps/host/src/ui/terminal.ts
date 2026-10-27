import type { RichTerminal } from './spinner'

interface Tty {
  isTTY?: boolean
  hasColors?: () => boolean
}

/**
 * A person's terminal: stdin and stdout are a TTY, it is not a CI log or a
 * dumb terminal, and PHOSPHOR_PLAIN is unset. Anything else, an agent's
 * shell or a pipe, gets the plain lines scripts read.
 */
export function richTerminal(
  env: NodeJS.ProcessEnv,
  input: RichTerminal['input'] & Tty = process.stdin,
  output: RichTerminal['output'] & Tty = process.stdout,
  interrupt: () => void = () => process.kill(process.pid, 'SIGINT'),
): RichTerminal | undefined {
  if (input.isTTY !== true || output.isTTY !== true) return undefined
  if (env.TERM === 'dumb' || env.PHOSPHOR_PLAIN || isCi(env)) return undefined
  // hasColors honours NO_COLOR, FORCE_COLOR and the terminal's own depth.
  return { input, output, color: output.hasColors?.() ?? false, animate: true, interrupt }
}

const isCi = (env: NodeJS.ProcessEnv) =>
  Boolean(env.CI && env.CI !== 'false') || Boolean(env.GITHUB_ACTIONS)
