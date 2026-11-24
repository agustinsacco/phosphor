import process from 'node:process'
import { execFileSync, spawnSync } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

/**
 * The rest of the rehearsal runs a stub pi, so it cannot see how this Mac's own pi starts.
 * This check runs the build's `setup` the way Desktop does, with the login shell's PATH and
 * the real pi, then reads setup's pi check: setup probes pi in the environment it writes for
 * the service, not in the caller's. Writes under HOME and launchctl are fenced off.
 */
export function realPiFence(home, root) {
  const profile = `(version 1) (allow default)
(deny file-write* (require-all (subpath (param "HOME")) (require-not (subpath (param "ROOT")))))
(deny process-exec (literal "/bin/launchctl"))`
  return [`-DHOME=${home}`, `-DROOT=${root}`, '-p', profile]
}

/** setup's `pi` check, with paths replaced: the summary would name this Mac's folders. */
export function piCheck(stdout) {
  let report
  try {
    report = JSON.parse(stdout)
  } catch {
    return { status: 'fail', summary: 'setup printed no report' }
  }
  const pi = (Array.isArray(report?.checks) ? report.checks : []).find((c) => c?.id === 'pi')
  const summary = String(pi?.summary ?? report?.notes?.[0] ?? 'no pi check').replace(
    /\/\S*/g,
    '<path>',
  )
  return { status: pi?.status === 'pass' && report.exitCode === 0 ? 'pass' : 'fail', summary }
}

function loginPath(home) {
  const shell = process.env.SHELL || '/bin/zsh'
  return execFileSync(shell, ['-lc', 'printf %s "$PATH"'], {
    cwd: home,
    encoding: 'utf8',
    timeout: 15000,
  })
}

export function realPiSetup(root, host) {
  const home = homedir(),
    dir = join(root, 'real-pi')
  for (const name of ['config', 'state']) mkdirSync(join(dir, name), { recursive: true })
  const env = {
    HOME: home,
    LANG: process.env.LANG ?? 'en_US.UTF-8',
    PATH: loginPath(home),
    TMPDIR: dir,
    XDG_CONFIG_HOME: join(dir, 'config'),
    XDG_STATE_HOME: join(dir, 'state'),
  }
  for (const name of ['USER', 'LOGNAME']) if (process.env[name]) env[name] = process.env[name]
  const args = ['setup', '--json', '--config', join(dir, 'config/phosphor-host/config.json')]
  const result = spawnSync(
    '/usr/bin/sandbox-exec',
    [...realPiFence(home, root), process.execPath, host, ...args],
    { cwd: dir, env, encoding: 'utf8', timeout: 120000, stdio: ['ignore', 'pipe', 'ignore'] },
  )
  return piCheck(result.stdout ?? '')
}
