import { useState } from 'react'
import clsx from 'clsx'
import type { McpResolvedServer } from '@shared/mcp'
import { Button, Toggle } from '@/components/form'
import { TooltipButton, TooltipSummary } from '@/components/Tooltip'
import { ChevronIcon } from '@/components/icons'
import { FlowCard } from '@/features/connectors/FlowCard'
import { STATE_DOT, connectorStatus } from '@/features/connectors/mcpStatus'
import type { ConnectorCheckView } from '@/features/connectors/useConnectorChecks'
import { ToolBrowser } from '@/features/connectors/ToolBrowser'
import { ExposureEditor, useToolVisibility } from '@/features/connectors/ExposureEditor'
import { LaneConnectorStatus } from '@/features/connectors/LaneConnectorStatus'
import type { ConnectorView, ConnectorsSource } from './source'

interface RowProps {
  connector: ConnectorView
  source: ConnectorsSource
  onEdit: () => void
  onRemove: () => void
}

/** One configured connector, on every machine. What a machine cannot do is left out. */
export function ConfiguredRow(props: RowProps): React.JSX.Element {
  const { connector, source } = props
  const inspection = source.caps.inspect ? connector.inspection : undefined
  return (
    <div
      className="border-border bg-surface rounded-xl border"
      data-testid={`connector-${connector.entry?.id ?? connector.name}`}
      data-connector={connector.name}
    >
      <ConnectorHeader {...props} />
      {!connector.oauth && connector.status.state === 'needs-auth' && (
        <p className="text-text-secondary px-3.5 pb-2 text-sm">
          Update this connector’s credential source or provider sign-in, then test again. It does
          not use MCP OAuth.
        </p>
      )}
      {connector.flow && (
        <div className="px-3.5 pb-2">
          <FlowCard serverName={connector.name} flow={connector.flow} />
        </div>
      )}
      {inspection ? (
        <Inspection {...props} server={inspection.server} check={inspection.check} />
      ) : (
        <div className="border-border flex flex-wrap items-center gap-4 border-t px-3.5 py-2 text-sm">
          <span className="text-text-tertiary">
            {connector.transport === 'stdio' ? 'command' : 'https'} · exposure: {connector.exposure}
          </span>
          <RowControls {...props} />
        </div>
      )}
    </div>
  )
}

function scopeBadge({ scope, inherited, overridden, replacesGlobal }: ConnectorView): string {
  if (overridden) return 'machine · folder override'
  if (replacesGlobal) return 'folder · replaces machine'
  if (inherited) return 'machine'
  return scope === 'global' ? 'machine' : 'folder'
}

function ConnectorHeader({ connector, source }: RowProps): React.JSX.Element {
  const { status, enabled } = connector
  const shown = connectorStatus(enabled, status)
  const state = shown.state
  // Sign in where pi uses OAuth and the last answer asks for it. Without a
  // per-server check, the machine never knows, so it is always offered.
  const signIn =
    connector.oauth &&
    enabled &&
    !status.checking &&
    (state === 'needs-auth' ||
      state === 'failed' ||
      status.failed ||
      connector.flow?.phase === 'failed' ||
      (!state && !source.caps.inspect))
  return (
    <div className="flex flex-wrap items-start gap-3 px-3.5 pt-3 pb-2.5">
      <div className="min-w-0 flex-1">
        <div className="flex flex-wrap items-center gap-2">
          <span
            className={clsx('text-lg font-semibold', !enabled && 'text-text-tertiary line-through')}
          >
            {connector.name}
          </span>
          <span className="bg-bg-secondary text-text-tertiary rounded px-1.5 text-xs">
            {scopeBadge(connector)}
          </span>
          <span className="text-text-secondary flex items-center gap-1.5 text-sm">
            {state && <span className={clsx('h-1.5 w-1.5 rounded-full', STATE_DOT[state])} />}
            {shown.label}
          </span>
        </div>
        {connector.entry && (
          <p className="text-text-secondary mt-0.5 text-base">{connector.entry.summary}</p>
        )}
        {connector.endpoint !== undefined && (
          <p className="text-text-tertiary mt-0.5 truncate font-mono text-sm">
            {connector.endpoint}
          </p>
        )}
      </div>
      {source.caps.inspect && (
        <Button
          size="sm"
          disabled={status.checking || !enabled}
          onClick={() => void source.run({ type: 'test', name: connector.name })}
          tooltip={{
            label: 'Test connector',
            description: 'Separate native pi probe; does not change your lane or call tools',
          }}
        >
          {status.checking ? 'Testing…' : status.failed ? 'Retry' : 'Test'}
        </Button>
      )}
      {signIn && (
        <Button
          size="sm"
          disabled={source.busy || !source.canSignIn}
          onClick={() => void source.run({ type: 'signIn', name: connector.name })}
        >
          {state === 'needs-auth' || (!state && !status.failed) ? 'Sign in' : 'Authorize…'}
        </Button>
      )}
    </div>
  )
}

/** Tests, tools, visibility and lane status, where the machine can inspect. */
function Inspection(
  props: RowProps & { server: McpResolvedServer; check?: ConnectorCheckView },
): React.JSX.Element {
  const { connector, source, server, check } = props
  const [showTools, setShowTools] = useState(false)
  const workspacePath = source.files?.workspacePath
  // A folder changes visibility only where its own file decides it.
  const editable = !connector.inherited || connector.overridden
  const visibility = useToolVisibility(server, workspacePath, source.refresh)
  const tools = check?.snapshot?.tools ?? []
  const error = visibility.error ?? check?.error ?? check?.snapshot?.report.error
  return (
    <>
      {error && (
        <p role="alert" className="text-danger px-3.5 pb-2 text-sm break-words">
          {error}
        </p>
      )}
      <ConnectorDetails connector={connector} check={check} />
      <div className="border-border flex flex-wrap items-center gap-4 border-t px-3.5 py-2 text-sm">
        <TooltipButton
          onClick={() => setShowTools((shown) => !shown)}
          aria-expanded={showTools}
          className="flex items-center gap-1.5"
        >
          <ChevronIcon size={8} expanded={showTools} />
          Tools{tools.length ? ` (${tools.length})` : ''}
        </TooltipButton>
        <span className="text-text-tertiary">exposure: {connector.exposure}</span>
        <RowControls {...props} />
      </div>
      {showTools && (
        <ToolBrowser
          tools={tools}
          rules={server.config.toolExposure}
          saving={visibility.saving}
          {...(editable && {
            onExposure: (name, exposure) => void visibility.update(name, exposure),
          })}
        />
      )}
      <LaneConnectorStatus workspacePath={source.laneWorkspace} name={server.name} />
      {editable && (
        <ExposureEditor
          key={JSON.stringify([server.config.exposure, server.config.toolExposure])}
          server={server}
          workspacePath={workspacePath}
          onSaved={source.refresh}
        />
      )}
    </>
  )
}

function ConnectorDetails({
  connector,
  check,
}: {
  connector: ConnectorView
  check?: ConnectorCheckView
}): React.JSX.Element {
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
        <dd>{connector.oauth ? 'OAuth managed by pi' : 'Credential source managed by pi'}</dd>
        <dt>Lifecycle</dt>
        <dd>Native pi manages connections. This test does not describe other lanes.</dd>
      </dl>
    </details>
  )
}

function RowControls({ connector, source, onEdit, onRemove }: RowProps): React.JSX.Element {
  const { name, inherited, oauth, enabled } = connector
  const locked = source.busy || source.locked
  return (
    <div className="ml-auto flex flex-wrap items-center gap-3">
      {oauth && (
        <Button
          size="xs"
          disabled={source.busy || !source.canSignIn}
          onClick={() => void source.run({ type: 'signOut', name })}
        >
          Sign out
        </Button>
      )}
      {source.caps.edit && (
        <Button
          size="xs"
          disabled={locked || inherited}
          tooltip={inherited ? 'Switch to Machine scope to edit it' : undefined}
          onClick={onEdit}
        >
          Edit
        </Button>
      )}
      <Button
        size="xs"
        disabled={locked || inherited || (oauth && !source.canSignIn)}
        tooltip={inherited ? 'Switch to Machine scope to remove it' : undefined}
        onClick={onRemove}
      >
        Remove
      </Button>
      <Toggle
        label={inherited ? 'Enabled in this folder' : 'Enabled'}
        on={enabled}
        disabled={locked}
        onChange={(next) => void source.run({ type: 'enabled', name, enabled: next })}
      />
    </div>
  )
}
