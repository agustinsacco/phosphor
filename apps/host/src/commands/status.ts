import type { HostSelfResponse } from '@phosphor/shared/control-api'
import { EXIT } from '../checks'
import { controlResult, prepareControl, type ControlContext } from '../control/command'
import type { HostIdentity } from '../control/identity'

export interface StatusReport {
  version: 1
  status: 'confirmed' | 'not-enrolled' | 'removed' | 'unreachable' | 'invalid'
  identity: HostIdentity | null
  server: HostSelfResponse | null
  error: string | null
}
export async function runStatus(
  context: ControlContext,
): Promise<{ exitCode: number; report: StatusReport }> {
  const report: StatusReport = {
    version: 1,
    status: 'not-enrolled',
    identity: null,
    server: null,
    error: null,
  }
  try {
    const { loaded, client } = await prepareControl(context)
    if (!loaded) return { exitCode: EXIT.unavailable, report }
    report.identity = loaded.identity
    report.server = await client.self(loaded.identity.hostId, loaded.key)
    report.status = 'confirmed'
    return { exitCode: EXIT.ok, report }
  } catch (error) {
    const result = controlResult(error, context.signal)
    report.status =
      result.exitCode === EXIT.noperm
        ? 'removed'
        : result.exitCode === EXIT.tempfail
          ? 'unreachable'
          : 'invalid'
    report.error = result.message
    return { exitCode: result.exitCode, report }
  }
}

export function renderStatus(report: StatusReport): string {
  if (!report.identity) return `${report.error ?? 'This machine is not signed in.'}\n`
  const owner =
    report.identity.ownerLogin === null
      ? 'your account'
      : `@${report.identity.ownerLogin}'s account`
  const lines = [`Signed in as ${JSON.stringify(report.identity.label)} on ${owner}.`]
  if (report.server) {
    lines.push(
      `Server: ${JSON.stringify(report.server.label)}; owner: ${report.server.owner.login === null ? 'unknown' : `@${report.server.owner.login}`}.`,
      `Enrolled: ${report.server.enrolledAt}. Last seen: ${report.server.lastSeenAt ?? 'never'}.`,
    )
  } else if (report.error) lines.push(report.error)
  return `${lines.join('\n')}\n`
}
