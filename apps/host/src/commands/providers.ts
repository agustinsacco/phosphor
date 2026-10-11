import { EXIT } from '../checks'
import { describeProvider, type ProviderState } from '../machine/providers'
import { inspectHost, type DoctorContext, type DoctorReport, type Lane } from './doctor'

/** How to sign in on a Host today: pi's and Claude Code's own logins, in a terminal on it. */
export const SIGN_IN_STEPS = [
  'on this machine, run pi, type /login and pick a provider; for the claude lane,',
  'run claude auth login. Open the link it prints on any computer, and paste back',
  'the code the page shows, or the address of a page that does not load.',
  'Then run phosphor providers again.',
].join(' ')

export interface ProvidersReport {
  /** Something a session can run on: a signed-in provider, or the claude lane. */
  ok: boolean
  exitCode: number
  hostId: string
  providers: ProviderState[]
  claude: Lane
  next: string
}

export type ProvidersOutcome =
  | { report: ProvidersReport }
  /** pi itself is unusable, so nothing was asked: doctor's report says why. */
  | { exitCode: number; problem: string; doctor: DoctorReport }

/**
 * Which providers this Host's pi can use, after doctor's checks: the same pi,
 * the same environment, the same rules. Exits 69 when nothing is signed in,
 * so a script can wait for a login.
 */
export async function runProviders(context: DoctorContext): Promise<ProvidersOutcome> {
  const { report } = await inspectHost(context)
  if (!report.providers) {
    const problem = 'pi is not usable here, so it was not asked about providers'
    return { exitCode: report.exitCode, problem, doctor: report }
  }
  const { providers } = report
  const claude = report.lanes.claude
  const ok = providers.some((provider) => provider.status === 'ready') || claude.available
  // doctor names the accept that passes here, whenever its checks did.
  const next = !ok ? SIGN_IN_STEPS : (report.next ?? 'fix what phosphor doctor reports')
  return {
    report: {
      ok,
      exitCode: ok ? EXIT.ok : EXIT.unavailable,
      hostId: report.config.hostId ?? '',
      providers,
      claude,
      next,
    },
  }
}

export function renderProviders(report: ProvidersReport): string {
  const name = Math.max(...report.providers.map((provider) => provider.name.length))
  const lines = [`phosphor providers · ${report.hostId}`]
  for (const provider of report.providers) {
    const mark =
      provider.status === 'ready' ? 'ok  ' : provider.status === 'unknown' ? '?   ' : '-   '
    const id = provider.default ? `${provider.id}, pi's default` : provider.id
    lines.push(`  ${mark}  ${provider.name.padEnd(name)}  ${describeProvider(provider)} (${id})`)
  }
  const claude = report.claude.available
    ? `available${report.claude.detail ? `: ${report.claude.detail}` : ''}`
    : `unavailable: ${report.claude.reason}`
  lines.push(`claude lane: ${claude}`, `next: ${report.next}`)
  return `${lines.join('\n')}\n`
}
