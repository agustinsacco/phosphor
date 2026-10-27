import type { AcceptEvidence } from '../commands/accept'
import type { DoctorReport, Lane } from '../commands/doctor'
import type { ProvidersReport } from '../commands/providers'
import { describeProvider } from '../machine/providers'
import type { Screen } from './screen'
import { CHECK_TONE, type Paint, type Row, type Tone } from './theme'

/** Paths under the home folder, as a person types them. */
export function tildify(home: string, text: string): string {
  if (!home || home === '/') return text
  return text.split(`${home}/`).join('~/')
}

/** Commands in a sentence, picked out so they read as something to type. */
export function commands(paint: Paint, text: string): string {
  return text.replace(
    /\b((?:phosphor|pi|sudo|npm|curl|tailscale|systemctl|journalctl) [^()\n]*?)(?=\s+\(|$|\. )/g,
    (command) => paint('cyan', command),
  )
}

/** "a sentence: a command" as the sentence, then the command on its own line. */
export function nextStep(paint: Paint, next: string): string {
  const split = /^(.*?):\s+((?:phosphor|pi|sudo|npm|curl|tailscale) .*)$/.exec(next)
  if (!split) return commands(paint, capital(next))
  return `${capital(split[1]!)}:\n${commands(paint, split[2]!)}`
}

function capital(text: string): string {
  return text.charAt(0).toUpperCase() + text.slice(1)
}

const laneRow = (name: string, lane: Lane, home: string): Row =>
  lane.available
    ? { tone: 'ok', name, text: tildify(home, lane.detail ? lane.detail : 'available') }
    : { tone: 'skip', name, text: tildify(home, lane.reason ?? 'unavailable') }

/** doctor's report: the machine's checks, its lanes, then what is next. */
export function showDoctor(screen: Screen, report: DoctorReport, home: string): void {
  const { paint } = screen
  const failed = report.checks.some((check) => check.status === 'fail')
  const rows = report.checks.map((check): Row => ({
    tone: CHECK_TONE[check.status],
    name: check.id,
    text: tildify(home, check.summary),
  }))
  const errors = (report.config.errors ?? []).map((error) =>
    paint('red', `  ${error.pointer || '(file)'}: ${error.message}`),
  )
  screen.list('This machine', rows, failed ? 'fail' : 'ok', errors)
  screen.list('Lanes', [
    laneRow('native', report.lanes.native, home),
    laneRow('claude', report.lanes.claude, home),
  ])
  if (report.environment)
    screen.say(paint('dim', `pi receives ${report.environment.names.join(' ')}`), 'info')
  if (report.next) screen.say(nextStep(paint, report.next), report.ok ? 'info' : 'warn')
  screen.close(
    report.ok ? 'Ready.' : `Not ready (exit ${report.exitCode}).`,
    report.ok ? 'done' : 'fail',
  )
}

/** What pi can sign into here, the claude lane, then what is next. */
export function showProviders(screen: Screen, report: ProvidersReport, home: string): void {
  const { paint } = screen
  const rows = report.providers.map((provider): Row => ({
    tone: provider.status === 'ready' ? 'ok' : provider.status === 'unknown' ? 'warn' : 'skip',
    name: provider.name,
    text:
      describeProvider(provider) +
      paint('dim', ` · ${provider.id}${provider.default ? ", pi's default" : ''}`),
  }))
  const signedIn = report.providers.filter((provider) => provider.status === 'ready').length
  screen.list(`Providers · ${signedIn} signed in`, rows, signedIn ? 'ok' : 'done')
  screen.list('Lanes', [laneRow('claude', report.claude, home)])
  screen.say(nextStep(paint, report.next), 'info')
  screen.close(
    report.ok ? 'Ready.' : 'Nothing to run sessions on yet.',
    report.ok ? 'done' : 'warn',
  )
}

/** One accept progress line as a row: steps that passed, failed or could not run. */
export function acceptProgress(line: string): { tone: Tone; text: string } {
  const tone: Tone = / FAILED\b/.test(line)
    ? 'fail'
    : /: unavailable: /.test(line)
      ? 'skip'
      : / ok \(\d+ ms\)$/.test(line)
        ? 'ok'
        : 'info'
  return { tone, text: line }
}

const VERDICT: Record<AcceptEvidence['lanes'][number]['verdict'], Tone> = {
  pass: 'ok',
  fail: 'fail',
  unavailable: 'skip',
}

/** accept's evidence: each lane, with its steps unless they were shown live, the drain, then the verdict. */
export function showAccept(
  screen: Screen,
  evidence: AcceptEvidence,
  home: string,
  steps = true,
): void {
  const { paint } = screen
  for (const lane of evidence.lanes) {
    const runsOn = [lane.provider, lane.model, lane.thinkingLevel].filter(Boolean).join(' · ')
    const rows = (steps ? lane.steps : []).map((step): Row => ({
      tone: step.ok ? 'ok' : 'fail',
      name: step.name,
      text: step.ok ? paint('dim', `${step.ms} ms`) : tildify(home, step.detail ?? ''),
    }))
    const kept =
      lane.transcript && !lane.transcriptDeleted
        ? [paint('dim', `transcript kept: ${tildify(home, lane.transcript)}`)]
        : []
    const title = `${lane.lane} lane${lane.reason ? `: ${lane.reason}` : runsOn ? ` · ${runsOn}` : ''}`
    screen.list(title, rows, VERDICT[lane.verdict], kept)
  }
  const drain = evidence.drain
  screen.say(
    drain ? `Drain ${drain.state}, ${drain.remaining.length} groups left` : 'Drained by a signal',
    drain?.state === 'stopped' ? 'done' : 'fail',
  )
  if (evidence.log) screen.say(paint('dim', `Log: ${tildify(home, evidence.log)}`), 'info')
  screen.close(
    evidence.verdict === 'pass' ? 'Accepted: real sessions ran here.' : 'Not accepted.',
    evidence.verdict === 'pass' ? 'done' : 'fail',
  )
}
