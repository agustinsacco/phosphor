import { useEffect, useRef, useState } from 'react'
import { errorText } from '@shared/errors'
import type { MachineSettings } from '@shared/machine-settings'
import type { McpServerConfig, McpServerState } from '@shared/mcp'
import type { SettingsNoticeProps } from '@/components/form'
import { buildConnectorConfig, CONNECTORS } from '@/features/connectors/catalog'
import { promptChoice } from '@/stores/prompt'
import { useHostSection, type HostSection } from '../../machine/HostSection'
import type { ConnectorOp, ConnectorView, ConnectorsSource } from './source'

type HostServer = NonNullable<MachineSettings['connectors']>['servers'][number]

function connectorView(server: HostServer, folder: boolean): ConnectorView {
  return {
    name: server.name,
    scope: server.scope,
    inherited: folder && server.scope === 'global',
    overridden: server.overridden === true,
    transport: server.transport,
    enabled: server.enabled,
    // A Host too old to say offers sign-in on every https connector.
    oauth: server.transport === 'https' && server.oauth !== false,
    exposure: server.exposure,
    // A Host never sends a URL, so a catalogue entry is known by its server name.
    entry: CONNECTORS.find((entry) => entry.serverName === server.name),
    // The shared parser keeps only pi's states.
    status: { state: server.state as McpServerState | undefined, tools: server.tools },
  }
}

function hostNotices(state: NonNullable<MachineSettings['connectors']>, label: string) {
  const notices: SettingsNoticeProps[] = []
  if (state.legacy)
    notices.push({
      tone: 'warning',
      title: `${label} still has pi-mcp-adapter configuration.`,
      body: `Migrate it on ${label} before editing built-in MCP connectors. Nothing has been rewritten.`,
    })
  if (state.malformed)
    notices.push({
      tone: 'warning',
      title: 'The Host’s MCP configuration has errors.',
      body: `Fix it on ${label}; this page will not overwrite malformed settings.`,
    })
  if (state.trusted === false)
    notices.push({
      tone: 'warning',
      title: 'This folder is not trusted by pi, so its MCP overrides are not active.',
      body: `Review and trust it under Folders before using them.${state.inactiveNames?.length ? ` Saved but inactive folder entries include: ${state.inactiveNames.join(', ')}.` : ''}`,
    })
  return notices
}

/** Confirms a write on the Host; a command connector needs its code trusted too. */
async function confirmUpsert(
  host: HostSection,
  name: string,
  config: McpServerConfig,
): Promise<'save' | 'code' | undefined> {
  const code = typeof config.command === 'string'
  const answer = await promptChoice({
    title: `Add ${name} on ${host.machine.label}?`,
    message: `${host.repositoryId ? 'Folder-specific configuration' : 'Machine-wide configuration'}. ${code ? `This starts code as the Host user: ${config.command} ${(config.args ?? []).join(' ')}. Only approve a source you trust.` : 'Credentials are stored only on this Host. Review the provider’s requested scopes during sign-in.'} Existing lanes will not restart.`,
    choices: [
      {
        value: 'save',
        label: code ? 'I trust this code: add server' : 'Save on this Host',
        primary: true,
      },
    ],
  })
  return answer === 'save' ? (code ? 'code' : 'save') : undefined
}

/** A check starts the Host's command connectors, so the user confirms it first. */
async function confirmCheck(label: string): Promise<boolean> {
  const answer = await promptChoice({
    title: `Check connectors on ${label}?`,
    message:
      'pi will connect to the configured servers, including starting stdio commands as the Host user. Only continue if you trust this Host’s MCP configuration. Results are not copied to another machine.',
    choices: [{ value: 'check', label: 'Check on this Host', primary: true }],
  })
  return answer === 'check'
}

async function saveOnHost(
  host: HostSection,
  name: string,
  config: McpServerConfig,
  setError: (error: string | null) => void,
): Promise<boolean> {
  const approved = await confirmUpsert(host, name, config)
  if (!approved) return false
  const saved = await host.settings.change({
    type: 'mcp.upsert',
    name,
    config,
    ...(approved === 'code' ? { approveCode: true as const } : {}),
  })
  if (!saved)
    setError(
      'The Host did not confirm this save. Refresh its configuration before trying again; the change may already have applied.',
    )
  return saved !== null
}

/**
 * Removing a server that signs in with OAuth signs it out on the Host first,
 * in a private program, and removes it only once that program succeeded: a
 * failed or cancelled sign-out keeps the server, so no token is orphaned.
 */
function useSignOutThenRemove(host: HostSection, setError: (error: string | null) => void) {
  const latest = useRef(host)
  latest.current = host
  const pending = useRef<{ ptyId: string; name: string } | null>(null)
  const failed = (name: string) =>
    setError(
      `${name} was not removed: it was not signed out on ${latest.current.machine.label}. Try again.`,
    )
  // Closing the program before it finished cancels the removal.
  const programId = host.program?.ptyId
  useEffect(() => {
    const waiting = pending.current
    if (waiting && programId !== waiting.ptyId) {
      pending.current = null
      failed(waiting.name)
    }
  })
  return async (name: string): Promise<boolean> => {
    const { machine, repositoryId, programs } = latest.current
    setError(null)
    const ptyId = await programs.openTask(
      { task: 'mcp.logout', name, ...(repositoryId ? { repositoryId } : {}) },
      'Connector sign-out',
      `pi signs ${name} out on ${machine.label}. Once it succeeds, ${name} is removed from this scope.`,
    )
    if (ptyId === null) return false
    const off = window.phosphor.onPtyExit(ptyId, (code) => {
      off()
      if (pending.current?.ptyId !== ptyId) return
      pending.current = null
      if (code !== 0) return failed(name)
      void latest.current.settings.change({ type: 'mcp.remove', name })
    })
    pending.current = { ptyId, name }
    return true
  }
}

/**
 * A Host's connectors in the chosen scope, through its reviewed settings API:
 * no URLs, no raw files, no per-server tests. Checks, command connectors and
 * sign-in programs are confirmed first (`caps.reviewed`).
 */
export function useHostConnectors(): ConnectorsSource {
  const host = useHostSection()
  const { machine, settings, programs, repositoryId } = host
  const [error, setError] = useState<string | null>(null)
  const signOutThenRemove = useSignOutThenRemove(host, setError)
  const state = settings.data?.connectors
  const folder = repositoryId !== undefined
  const servers = state?.servers.map((server) => connectorView(server, folder)) ?? null

  const save = (name: string, config: McpServerConfig) => saveOnHost(host, name, config, setError)
  const program = (task: 'mcp.login' | 'mcp.logout', name: string): void =>
    programs.task({ task, name, ...(repositoryId ? { repositoryId } : {}) })

  const run = async (op: ConnectorOp): Promise<boolean> => {
    setError(null)
    switch (op.type) {
      case 'enabled':
        return (
          (await settings.change({ type: 'mcp.enabled', name: op.name, enabled: op.enabled })) !==
          null
        )
      case 'remove':
        if (servers?.find((server) => server.name === op.name)?.oauth)
          return signOutThenRemove(op.name)
        return (await settings.change({ type: 'mcp.remove', name: op.name })) !== null
      case 'signIn':
      case 'signOut':
        program(op.type === 'signIn' ? 'mcp.login' : 'mcp.logout', op.name)
        return true
      case 'checkAll':
        if (!(await confirmCheck(machine.label))) return false
        await settings.check()
        return true
      case 'upsert':
        return save(op.name, op.config)
      case 'catalogue': {
        let config: McpServerConfig
        try {
          config = buildConnectorConfig(op.entry, op.choice)
        } catch (err) {
          setError(errorText(err))
          return false
        }
        if (!(await save(op.entry.serverName, config))) return false
        // As on This Mac, Add goes on to the sign-in, once the Host confirmed the save.
        if (programs.available) program('mcp.login', op.entry.serverName)
        return true
      }
      case 'test':
      case 'cancelChecks':
        return false
    }
  }

  return {
    caps: { inspect: false, edit: false, rawFiles: false, reviewed: true },
    folder,
    servers,
    notices: state ? hostNotices(state, machine.label) : [],
    error,
    locked: !state || state.legacy || state.malformed,
    busy: settings.loading || settings.saving || programs.busy,
    canSignIn: programs.available && !programs.busy,
    checking: settings.checking,
    slow: false,
    ...(state?.checkedAt !== undefined ? { checkedAt: state.checkedAt } : {}),
    run,
    refresh: settings.refresh,
  }
}
