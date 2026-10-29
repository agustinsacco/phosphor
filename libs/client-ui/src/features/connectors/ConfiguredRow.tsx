import { useState } from 'react'
import clsx from 'clsx'
import { exposureSummary, type McpResolvedServer } from '@shared/mcp'
import { Button } from '@/components/form'
import { TooltipButton, TooltipLabel, TooltipSummary } from '@/components/Tooltip'
import { ChevronIcon } from '@/components/icons'
import type { ConnectFlow } from '@/stores/connectors'
import { FlowCard } from './FlowCard'
import type { ConnectorEntry } from './catalog'
import { STATE_DOT, stateLabel } from './mcpStatus'
import type { ConnectorCheckView } from './useConnectorChecks'
import { ToolBrowser } from './ToolBrowser'
import { ExposureEditor, useToolVisibility } from './ExposureEditor'
import { LaneConnectorStatus } from './LaneConnectorStatus'

export function usesOAuth(server: McpResolvedServer): boolean {
  return (
    Boolean(server.config.url) &&
    !server.config.auth &&
    !Object.keys(server.config.headers ?? {}).some((name) => name.toLowerCase() === 'authorization')
  )
}

function endpoint(server: McpResolvedServer): string {
  if (!server.config.url) return server.config.command ?? ''
  try {
    const url = new URL(server.config.url)
    return url.origin + url.pathname
  } catch {
    return 'Invalid endpoint'
  }
}

interface RowProps {
  server: McpResolvedServer
  entry?: ConnectorEntry
  check?: ConnectorCheckView
  workspacePath?: string
  flow?: ConnectFlow
  onTest: () => void
  onSignIn: () => void
  onToggle: (enabled: boolean) => void
  onRemove: () => void
  onEdit: () => void
  onRefresh: () => void | Promise<void>
}

export function ConfiguredRow(props: RowProps): React.JSX.Element {
  const { server, check, workspacePath } = props
  const [showTools, setShowTools] = useState(false)
  const visibility = useToolVisibility(server, workspacePath, props.onRefresh)
  const tools = check?.snapshot?.tools ?? []
  const error = visibility.error ?? check?.error ?? check?.snapshot?.report.error
  return (
    <div
      className="border-border bg-surface rounded-xl border"
      data-testid={`connector-${props.entry?.id ?? server.name}`}
    >
      <ConnectorHeader {...props} />
      {error && (
        <p role="alert" className="text-danger px-3.5 pb-2 text-sm break-words">
          {error}
        </p>
      )}
      {!usesOAuth(server) && check?.snapshot?.report.state === 'needs-auth' && (
        <p className="text-text-secondary px-3.5 pb-2 text-sm">
          Update this connector’s credential source or provider sign-in, then test again. It does
          not use MCP OAuth.
        </p>
      )}
      {props.flow && (
        <div className="px-3.5 pb-2">
          <FlowCard serverName={server.name} flow={props.flow} />
        </div>
      )}
      <ConnectorDetails {...props} />
      <div className="border-border flex flex-wrap items-center gap-4 border-t px-3.5 py-2 text-sm">
        <TooltipButton
          onClick={() => setShowTools((shown) => !shown)}
          aria-expanded={showTools}
          className="flex items-center gap-1.5"
        >
          <ChevronIcon size={8} expanded={showTools} />
          Tools{tools.length ? ` (${tools.length})` : ''}
        </TooltipButton>
        <span className="text-text-tertiary">
          exposure: {exposureSummary(server.config) ?? 'codemode'}
        </span>
        <RowControls {...props} />
      </div>
      {showTools && (
        <ToolBrowser
          tools={tools}
          rules={server.config.toolExposure}
          saving={visibility.saving}
          onExposure={(name, exposure) => void visibility.update(name, exposure)}
        />
      )}
      <LaneConnectorStatus workspacePath={workspacePath} name={server.name} />
      <ExposureEditor
        key={JSON.stringify([server.config.exposure, server.config.toolExposure])}
        server={server}
        workspacePath={workspacePath}
        onSaved={props.onRefresh}
      />
    </div>
  )
}

function ConnectorHeader({
  server,
  entry,
  check,
  flow,
  onSignIn,
  onTest,
}: RowProps): React.JSX.Element {
  const disabled = server.config.enabled === false
  // A failed check says nothing about the server, so it never reads as Down.
  const failedCheck = !disabled && Boolean(check?.error)
  const state = disabled ? 'disabled' : failedCheck ? undefined : check?.snapshot?.report.state
  const scope = server.overridden
    ? 'global · project override'
    : server.replacesGlobal
      ? 'project · replaces global'
      : server.scope
  return (
    <div className="flex flex-wrap items-start gap-3 px-3.5 pt-3 pb-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={clsx('text-lg font-semibold', disabled && 'text-text-tertiary line-through')}
          >
            {server.name}
          </span>
          <span className="bg-bg-secondary text-text-tertiary rounded px-1.5 text-xs">{scope}</span>
          <span className="text-text-secondary flex items-center gap-1.5 text-sm">
            {state && <span className={clsx('h-1.5 w-1.5 rounded-full', STATE_DOT[state])} />}
            {/* The last known state stays readable while a new check runs. */}
            {state
              ? `${stateLabel({
                  state,
                  tools: check?.snapshot?.tools.map((tool) => tool.name) ?? [],
                })}${check?.checking ? ' · checking…' : ''}`
              : check?.checking
                ? 'Checking…'
                : failedCheck
                  ? 'Check failed'
                  : 'Not checked'}
          </span>
        </div>
        {entry && <p className="text-text-secondary mt-0.5 text-base">{entry.summary}</p>}
        <p className="text-text-tertiary mt-0.5 truncate font-mono text-sm">{endpoint(server)}</p>
      </div>
      <Button
        size="sm"
        disabled={check?.checking || disabled}
        onClick={onTest}
        tooltip={{
          label: 'Test connector',
          description: 'Separate native pi probe; does not change your lane or call tools',
        }}
      >
        {check?.checking ? 'Testing…' : check?.error ? 'Retry' : 'Test'}
      </Button>
      {usesOAuth(server) &&
        !disabled &&
        !check?.checking &&
        (state === 'needs-auth' ||
          state === 'failed' ||
          failedCheck ||
          flow?.phase === 'failed') && (
          <Button size="sm" onClick={onSignIn}>
            {state === 'needs-auth' ? 'Sign in' : 'Authorize…'}
          </Button>
        )}
    </div>
  )
}

function ConnectorDetails({ server, check }: RowProps): React.JSX.Element {
  const snapshot = check?.snapshot
  const stale = check?.checking || check?.error || snapshot?.report.state !== 'connected'
  return (
    <details className="px-3.5 pb-2 text-sm">
      <TooltipSummary className="text-text-secondary cursor-pointer">
        Connection details
      </TooltipSummary>
      <dl className="text-text-tertiary mt-2 space-y-1">
        <dt>Last independent test</dt>
        <dd>{snapshot ? new Date(snapshot.checkedAt).toLocaleString() : 'Not yet checked'}</dd>
        <dt>Tool discovery</dt>
        <dd>
          {snapshot?.discoveredAt
            ? `${stale ? 'Last known' : 'Discovered'}: ${new Date(snapshot.discoveredAt).toLocaleString()}`
            : 'No successful discovery yet'}
        </dd>
        <dt>Authentication</dt>
        <dd>{usesOAuth(server) ? 'OAuth managed by pi' : 'Credential source managed by pi'}</dd>
        <dt>Lifecycle</dt>
        <dd>Native pi manages connections. This test does not describe other lanes.</dd>
        <dt>Configuration</dt>
        <dd>
          {server.scope}
          {server.overridden ? ' with a project override' : ''}
        </dd>
      </dl>
    </details>
  )
}

function RowControls({ server, onToggle, onEdit, onRemove }: RowProps): React.JSX.Element {
  return (
    <div className="ml-auto flex items-center gap-4">
      <TooltipLabel className="flex items-center gap-1.5">
        <input
          type="checkbox"
          checked={server.config.enabled !== false}
          onChange={(event) => onToggle(event.target.checked)}
        />
        enabled
      </TooltipLabel>
      <TooltipButton onClick={onEdit}>Edit</TooltipButton>
      <TooltipButton onClick={onRemove}>Remove</TooltipButton>
    </div>
  )
}
