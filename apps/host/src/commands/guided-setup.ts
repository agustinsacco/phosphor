import { EXIT } from '../checks'
import type { ControlContext } from '../control/command'
import type { ServiceContext } from './service'
import { runService } from './service'
import { serviceState } from './update'
import { runLogin } from './login'
import { runTailscale } from './tailscale'
import { runSetup, type SetupContext, type SetupReport } from './setup'

export type GuidedSetupContext = SetupContext & ServiceContext & ControlContext

/** Each completed step survives interruption. Login already resumes pending approvals. */
export async function runGuidedSetup(context: GuidedSetupContext): Promise<SetupReport> {
  const report = await runSetup(context)
  report.next = 'phosphor setup'
  if (report.exitCode !== EXIT.ok) return report
  context.print('Config ready.')
  const login = await runLogin(context)
  context.print(login.message)
  if (login.exitCode !== EXIT.ok) {
    report.exitCode = login.exitCode
    report.notes.push('Config ready. Next: phosphor setup')
    return report
  }
  const state = await serviceState(context)
  if (state.running && report.changed) {
    report.next = undefined
    report.notes.push('Config changed. Run phosphor service restart to apply; running lanes stop.')
    return report
  }
  if (!state.installed || !state.running) {
    const code = await runService(context, 'install')
    if (code !== EXIT.ok) {
      report.exitCode = code
      report.notes.push('Config and login ready. Next: phosphor setup')
      return report
    }
  }
  const tailscale = await runTailscale(context, 'enable', context.tailscale)
  context.print(tailscale.message)
  report.exitCode = tailscale.exitCode
  if (tailscale.exitCode !== EXIT.ok) {
    report.notes.push('Config, login and service ready. Next: phosphor setup')
    return report
  }
  report.next = undefined
  report.notes.push('Config, login, service and Tailscale ready. Open this machine in Desktop.')
  return report
}
