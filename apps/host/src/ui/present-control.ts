import { formatUserCode } from '@phosphor/shared/control-api'
import type { StatusReport } from '../commands/status'
import type { EnrollmentCode } from '../control/command'
import type { Screen } from './screen'
import { relativeTime, type Row } from './theme'

/** Whose account, as a person says it. */
const account = (login: string | null) => (login === null ? 'your account' : `@${login}'s account`)

/** The control plane's view of this machine; returns whether it is on an account. */
export function showStatus(screen: Screen, report: StatusReport, now: number): boolean {
  const { identity, server } = report
  if (!identity) {
    screen.say(report.error ?? 'This machine is not signed in.', report.error ? 'fail' : 'warn')
    screen.say(`Next: ${screen.paint('cyan', 'phosphor setup')}`, 'info')
    return false
  }
  const title = `Signed in as ${JSON.stringify(identity.label)} on ${account(identity.ownerLogin)}`
  if (!server) {
    screen.list(title, [], 'warn', [report.error ?? 'Phosphor could not confirm it.'])
    screen.say(`Next: ${screen.paint('cyan', 'phosphor setup')}`, 'info')
    return false
  }
  const rows: Row[] = [
    { tone: 'info', name: 'server', text: JSON.stringify(server.label) },
    {
      tone: 'info',
      name: 'owner',
      text: server.owner.login === null ? 'unknown' : `@${server.owner.login}`,
    },
    { tone: 'info', name: 'enrolled', text: relativeTime(server.enrolledAt, now) },
    { tone: 'info', name: 'last seen', text: relativeTime(server.lastSeenAt, now) },
  ]
  screen.list(title, rows, 'ok')
  return true
}

/** The code to type into Phosphor, framed so it cannot be missed. */
export function showEnrollment(screen: Screen, code: EnrollmentCode): void {
  const { paint } = screen
  screen.note(
    [
      '1. Open Phosphor on a computer where you are signed in.',
      `2. Go to ${paint('bold', 'Machines › Add a machine')} and enter:`,
      '',
      `     ${paint(['bold', 'cyan'], formatUserCode(code.userCode))}`,
      '',
      paint('dim', `Phosphor shows the same key fingerprint:`),
      paint('dim', code.fingerprint),
    ].join('\n'),
    code.resuming ? 'Add this machine (earlier code)' : 'Add this machine',
  )
}

/** systemd's and launchd's state lines, read back from the service command. */
export interface ServiceFacts {
  state?: string
  pid?: string
  exit?: string
  linger?: string
}

/** Collects a service status line; true when it was one, so it is not printed as is. */
export function serviceFact(facts: ServiceFacts, line: string): boolean {
  const pair =
    /^(ActiveState|SubState|MainPID|ExecMainStatus|state|pid|last exit code)\s*=\s*(\S+)$/.exec(
      line,
    )
  const linger = /^Linger: (\w+)$/.exec(line)
  if (linger) facts.linger = linger[1]
  else if (!pair) return false
  else if (pair[1] === 'ActiveState' || pair[1] === 'state') facts.state ??= pair[2]
  else if (pair[1] === 'SubState') facts.state = `${facts.state ?? 'unknown'} (${pair[2]})`
  else if (pair[1] === 'MainPID' || pair[1] === 'pid') facts.pid = pair[2]
  else facts.exit = pair[2]
  return true
}

/** One line for the service: running or not, its process and whether it outlives logout. */
export function showServiceFacts(screen: Screen, facts: ServiceFacts): void {
  if (!facts.state) return
  const running = /^(active|running)\b/.test(facts.state)
  const parts = [running ? 'Service running' : `Service ${facts.state}`]
  if (running && facts.pid && facts.pid !== '0') parts.push(`pid ${facts.pid}`)
  if (!running && facts.exit && facts.exit !== '0') parts.push(`last exit ${facts.exit}`)
  if (facts.linger) parts.push(`linger ${facts.linger}`)
  screen.say(parts.join(' · '), running ? (facts.linger === 'off' ? 'warn' : 'ok') : 'fail')
  if (running && facts.linger === 'off')
    screen.say(
      `It stops when you log out. To keep it running: ${screen.paint('cyan', 'sudo loginctl enable-linger $USER')}`,
      'info',
    )
}
