/**
 * Exit codes, and the shape every Host check reports in.
 *
 * The codes follow sysexits(3), so a script or service manager can tell a
 * bad config from a missing prerequisite without parsing output.
 */
export const EXIT = {
  ok: 0,
  usage: 64,
  /** A prerequisite is unavailable: node, pi, git, extensions or a repository. */
  unavailable: 69,
  internal: 70,
  tempfail: 75,
  noperm: 77,
  config: 78,
} as const

export type FailureExit = typeof EXIT.unavailable | typeof EXIT.config

export interface Check {
  /** Stable machine name, such as `pi` or `repository`. */
  id: string
  /** `info` reports a fact; only `fail` makes a command fail. */
  status: 'pass' | 'warn' | 'fail' | 'info'
  /** One line for a person: paths and versions, never variable values. */
  summary: string
  /** For a failure, the exit code it maps to. */
  exit?: FailureExit
}

export const pass = (id: string, summary: string): Check => ({ id, status: 'pass', summary })
export const warn = (id: string, summary: string): Check => ({ id, status: 'warn', summary })
export const info = (id: string, summary: string): Check => ({ id, status: 'info', summary })
export const fail = (id: string, summary: string, exit: FailureExit = EXIT.unavailable): Check => ({
  id,
  status: 'fail',
  summary,
  exit,
})

/** A config problem (78) outranks a missing prerequisite (69): fix the config first. */
export function exitCodeFor(checks: readonly Check[]): number {
  const failures = checks.filter((check) => check.status === 'fail')
  if (failures.some((check) => check.exit === EXIT.config)) return EXIT.config
  return failures.length > 0 ? EXIT.unavailable : EXIT.ok
}
