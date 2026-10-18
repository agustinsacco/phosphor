import { promptChoice } from '@/stores/prompt'
import type { MachineView } from '@shared/control-api'
import type { ProviderLoginOp } from '@shared/host-protocol-providers'
import type { MachineTaskOp } from '@shared/machine-settings'
import type { RefObject } from 'react'
import type { HostSettingsState } from './useHostSettings'
type OpenHostProgram = (
  start: () => Promise<{ ptyId: string }>,
  title: string,
  instructions: string,
) => Promise<void>
export async function loginHostProgram(
  machine: Pick<MachineView, 'id' | 'label'>,
  settings: HostSettingsState,
  openProgram: OpenHostProgram,
  provider: string,
  account?: Pick<ProviderLoginOp, 'accountId' | 'addAccount'>,
) {
  const name =
    provider === 'claude'
      ? 'Claude Code'
      : (settings.data?.providers?.providers.find((p) => p.id === provider)?.name ?? provider)
  await openProgram(
    () =>
      window.phosphor.invoke('hosts:providerLogin', machine.id, provider, {
        ...account,
        configure: true,
      }),
    'Provider sign-in',
    provider === 'claude'
      ? `Follow ${name}'s sign-in instructions here. Open its link and paste a code if requested; a loopback-only flow may need the browser on ${machine.label}. The CLI stores the account only on that Host.`
      : `pi opens on ${machine.label}. Type /login ${provider}, follow its supported account or code flow, then /quit. To sign out, use /logout ${provider}. API-key-only providers may instead need a credential or environment configuration on the Host.`,
  )
}
export async function runHostTask(
  machine: Pick<MachineView, 'id' | 'label'>,
  alive: RefObject<boolean>,
  openProgram: OpenHostProgram,
  input: Omit<MachineTaskOp, 'type'>,
) {
  const destructive = input.task === 'package.remove' || input.task === 'mcp.logout'
  const description =
    input.task === 'claude.installCli'
      ? 'Download Anthropic’s official https://claude.ai/install.sh over HTTPS and run it as the Host user. No sudo is requested by Phosphor.'
      : input.task === 'claude.installProvider'
        ? 'Run pi install npm:@saccolabs/pi-claude-cli on the Host. npm packages and their install scripts can run code as the Host user.'
        : input.task.startsWith('package.')
          ? `Run pi ${input.task.slice(8)} ${input.name} on the Host. Package install/update scripts can execute code as that user.`
          : input.task === 'folder.trust'
            ? 'Open pi in the selected Host folder to review its trust prompt. Project configuration may contain executable MCP commands. Phosphor does not approve it automatically.'
            : input.task === 'mcp.logout'
              ? `Sign ${input.name} out on this Host only. Existing sessions may lose connector access.`
              : `Run pi mcp login ${input.name} in a private terminal on the Host. Open the link here and follow pi’s supported remote callback/paste instructions.`
  if (
    (await promptChoice({
      title: `${input.task === 'folder.trust' ? 'Review project trust' : destructive ? 'Confirm change' : 'Run setup'} on ${machine.label}?`,
      message: `${description} Running lanes are not restarted.`,
      choices: [
        {
          value: 'run',
          label: destructive ? 'Confirm on this Host' : 'Continue on this Host',
          primary: true,
        },
      ],
    })) !== 'run' ||
    !alive.current
  )
    return
  await openProgram(
    () =>
      window.phosphor.invoke('hosts:machineTask', machine.id, { type: 'machine.task', ...input }),
    input.task === 'mcp.login' ? 'Connector sign-in' : 'Host setup',
    description + (input.task === 'folder.trust' ? ' Quit pi with /quit when finished.' : ''),
  )
}
