import type {
  AcceptContext,
  AcceptEvidence,
  AcceptLane,
  AcceptLaneResult,
  AcceptOutcome,
} from './accept'
import { EXIT } from '../checks'
import type { DrainResult } from '../session/lifecycle'
import { HOST_SOURCE_SHA, HOST_VERSION } from '../version'
import { redactStrings, type HostInspection } from './doctor'

export function acceptOutcome(
  inspection: HostInspection & { machine: NonNullable<HostInspection['machine']> },
  context: AcceptContext,
  results: AcceptLaneResult[],
  drain: DrainResult | null,
  logPath: string | null,
): AcceptOutcome {
  const { machine } = inspection
  const passed = results.some((lane) => lane.verdict === 'pass')
  const failed = results.some((lane) => lane.verdict === 'fail')
  const stopped = drain?.state === 'stopped'
  const { report, secrets, claude } = inspection
  const claudeLane = report.lanes.claude
  const evidence: AcceptEvidence = {
    schema: 1,
    verdict: passed && !failed && stopped ? 'pass' : 'fail',
    machine: `${report.config.hostId} · ${context.platform}-${process.arch}`,
    host: { version: HOST_VERSION, sourceSha: HOST_SOURCE_SHA, node: context.nodeVersion },
    pi: { version: inspection.piVersion, cli: machine.pi.prefixArgs[0] ?? machine.pi.binaryPath },
    claude: claude?.available
      ? { cli: claude.claude, version: claude.version }
      : { unavailable: claudeLane.reason ?? 'unavailable' },
    environment: { forwardedNames: report.environment?.names ?? [], valuesPrinted: false },
    lanes: results,
    drain,
    log: logPath,
  }
  return { exitCode: acceptExitCode(evidence), evidence: redactStrings(evidence, secrets) }
}

/**
 * 70 when the drain failed, a signal's drain ran instead (the signal then
 * sets the code), or a lane's cleanup failed; otherwise 0 for a pass and 1
 * for a failure.
 */
export function acceptExitCode(
  evidence: Pick<AcceptEvidence, 'verdict' | 'drain' | 'lanes'>,
): number {
  if (evidence.drain?.state !== 'stopped') return EXIT.internal
  if (evidence.lanes.some((lane) => lane.steps.some((step) => step.cleanup))) return EXIT.internal
  return evidence.verdict === 'pass' ? EXIT.ok : 1
}

export const unavailableLane = (lane: AcceptLane, reason: string): AcceptLaneResult => ({
  lane,
  verdict: 'unavailable',
  reason,
  steps: [],
  extensionsLoaded: false,
  groupsAlive: 0,
  transcriptDeleted: false,
})

const MARK = { pass: 'pass', fail: 'FAIL', unavailable: 'n/a ' } as const

export function renderAccept(evidence: AcceptEvidence): string {
  const lines = [`phosphor accept · ${evidence.machine} · ${evidence.host.version}`]
  for (const lane of evidence.lanes) {
    const runsOn = [lane.provider, lane.model, lane.thinkingLevel].filter(Boolean).join(' · ')
    lines.push(`${MARK[lane.verdict]}  ${lane.lane.padEnd(7)} ${lane.reason ?? runsOn}`)
    for (const step of lane.steps) {
      const how = step.ok ? `${step.ms} ms` : step.detail
      lines.push(`  ${step.ok ? 'ok  ' : 'FAIL'}  ${step.name.padEnd(8)} ${how}`)
    }
    if (lane.transcript && !lane.transcriptDeleted) lines.push(`  kept    ${lane.transcript}`)
  }
  const drain = evidence.drain
  lines.push(
    `drain ${drain ? `${drain.state}, ${drain.remaining.length} groups left` : 'by signal'}`,
  )
  if (evidence.log) lines.push(`log ${evidence.log}`)
  lines.push(evidence.verdict)
  return `${lines.join('\n')}\n`
}
