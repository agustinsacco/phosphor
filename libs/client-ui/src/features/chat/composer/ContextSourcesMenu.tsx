import { TooltipButton } from '@/components/Tooltip'
import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  CONTEXT_FILE_KINDS,
  CONTEXT_FILE_LABELS,
  type ContextFileKind,
} from '@shared/context-files'
import { exposesDirectTools } from '@shared/mcp'
import { ipcErrorText } from '@shared/errors'
import { PopupMenu } from '@/components/PopupMenu'
import { useContextFilesPrefStore } from '@/stores/contextFilesPref'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { useSessionsStore } from '@/stores/sessions'
import { useOpenSettings } from '@/features/settings/useOpenSettings'
import {
  CONTEXT_BREAKDOWN_STATUS_KEY,
  parseContextBreakdown,
  type ContextBreakdown,
} from './contextBreakdown'
import { contextFileToggleState } from './contextFileToggle'
import { useLaneContextSource, type LaneContextSource } from './laneContextSource'
import { RuleRows, ServerRows, type RuleRow, type ServerRow } from './ContextSourceRows'

/**
 * What a lane loads besides the conversation: instruction files (CLAUDE.md /
 * AGENTS.md) and MCP connectors, behind one readout in the status strip under
 * both composers ("Rules 2/2 · MCP 6/9").
 *
 * Rules: on the home composer they set what new lanes start with. Inside a
 * lane they change that lane from its next model request AND the starting
 * state of new lanes, so the last choice sticks. A lane's own state comes from
 * what its pi reports (`pi-ext/context-files.ts`), not from the preference,
 * which may have moved on since the lane started.
 *
 * Connectors: the servers' own `enabled` flag, as in Settings. pi reads it
 * when a lane starts; a running lane picks a change up right before its next
 * turn, when Phosphor reloads its extensions
 * (`libs/session-runtime/src/pi/lane-reload.ts`). Inside a lane the files are
 * read from the lane's own folder, a worktree's included, since that is the
 * `.pi/mcp.json` its pi loads. A lane also says which servers it has
 * connected, through its context breakdown.
 *
 * Without a write source (`useLaneContextSource`) the menu is read-only: rules
 * and connected servers come from the lane's breakdown alone, with no toggles.
 */
/** Settings › Connectors on the lane's own machine; the default machine without a lane. */
function useOpenLaneConnectors(sessionId: string | undefined): () => void {
  const target = useSessionsStore((s) => (sessionId ? s.live[sessionId]?.target : undefined))
  const openSettings = useOpenSettings()
  const machine = target?.kind === 'remote' ? target.hostId : target ? 'local' : null
  return () => openSettings(machine, 'connectors')
}

export function ContextSourcesMenu({
  workspacePath,
  sessionId,
}: {
  workspacePath: string
  sessionId?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const source = useLaneContextSource(workspacePath, sessionId)
  const breakdownText = useExtensionUiStore((s) =>
    sessionId ? s.statuses[sessionId]?.[CONTEXT_BREAKDOWN_STATUS_KEY] : undefined,
  )
  const breakdown = useMemo(() => parseContextBreakdown(breakdownText), [breakdownText])
  const rules = useRuleRows(sessionId, breakdown?.contextFiles ?? null, source)
  const servers = serverRows(source, breakdown?.mcpByServer)
  const openConnectors = useOpenLaneConnectors(sessionId)
  const readOnly = !source

  const rulesOn = rules?.filter((rule) => rule.state.checked).length
  const enabled = servers.filter((server) => server.enabled).length
  const label = `Rules${rules ? ` ${rulesOn}/${rules.length}` : ''}${
    servers.length === 0
      ? ''
      : readOnly
        ? ` · MCP ${enabled}`
        : ` · MCP ${enabled}/${servers.length}`
  }`

  return (
    <div className="relative">
      <TooltipButton
        ref={triggerRef}
        type="button"
        data-testid="context-sources"
        onClick={() => {
          if (!open) void source?.mcp.refresh()
          setOpen((current) => !current)
        }}
        aria-expanded={open}
        tooltip="Instruction files and connectors"
        data-tooltip-open={open}
        className={clsx(
          'flex items-center rounded px-1 py-0.5 tabular-nums transition-colors',
          open
            ? 'bg-bg-secondary text-text'
            : 'text-text-secondary hover:bg-bg-secondary hover:text-text',
        )}
      >
        {label}
      </TooltipButton>
      {open && (
        <PopupMenu
          onClose={() => setOpen(false)}
          triggerRef={triggerRef}
          fitViewport
          className="absolute bottom-full left-0 mb-2 w-96 py-1"
        >
          <SectionHeading
            title="Instruction files"
            note={readOnly ? 'this lane' : sessionId ? 'from the next request' : 'new lanes'}
          />
          {rules ? (
            <RuleRows rules={rules} sessionId={sessionId} />
          ) : (
            <p className="text-text-tertiary px-3 py-1 text-sm">Not yet reported by this lane.</p>
          )}

          {servers.length > 0 && (
            <>
              <SectionHeading
                title="Connectors"
                note={
                  readOnly
                    ? 'connected in this lane'
                    : sessionId
                      ? 'from your next message'
                      : 'new lanes'
                }
                divided
              />
              <ServerRows servers={servers} />
              {source?.mcp.error && (
                <div className="text-danger px-3 py-1 text-sm">{source.mcp.error}</div>
              )}
            </>
          )}

          <div className="border-border mt-1 border-t px-3 pt-1.5 pb-1">
            <TooltipButton
              type="button"
              onClick={() => {
                setOpen(false)
                openConnectors()
              }}
              className="text-text-secondary hover:text-text text-sm"
            >
              Manage connectors…
            </TooltipButton>
          </div>
        </PopupMenu>
      )}
    </div>
  )
}

function SectionHeading({
  title,
  note,
  divided = false,
}: {
  title: string
  note: string
  divided?: boolean
}): React.JSX.Element {
  return (
    <div
      className={clsx(
        'text-text-tertiary flex items-baseline justify-between gap-2 px-3 pt-1.5 pb-0.5',
        divided && 'border-border mt-1 border-t',
      )}
    >
      <span className="text-2xs font-mono uppercase tracking-wider">{title}</span>
      <span className="truncate text-sm">{note}</span>
    </div>
  )
}

/**
 * The configured servers where the source can write them, else the servers the lane's breakdown
 * says it connected: only those are known, so each counts as on.
 */
function serverRows(
  source: LaneContextSource | null,
  connected: ContextBreakdown['mcpByServer'] | undefined,
): ServerRow[] {
  if (!source)
    return Object.entries(connected ?? {}).map(([name, cost]) => ({
      name,
      enabled: true,
      direct: false,
      tools: cost.toolCount,
    }))
  return (source.mcp.servers ?? []).map((server) => ({
    name: server.name,
    enabled: server.config.enabled !== false,
    direct: exposesDirectTools(server.config),
    tools: connected?.[server.name]?.toolCount,
    toggle: (on: boolean) => void source.mcp.setEnabled(server, on),
  }))
}

/**
 * Each rule file's state, with the lane's report and an optimistic click folded in. Read-only,
 * the state is the lane's report alone: null until it reports, never This Mac's preference.
 */
function useRuleRows(
  sessionId: string | undefined,
  lane: ContextBreakdown['contextFiles'],
  source: LaneContextSource | null,
): RuleRow[] | null {
  const prefs = useContextFilesPrefStore((s) => s.prefs)
  const [pending, setPending] = useState<Partial<Record<ContextFileKind, boolean>>>({})

  // The lane's next report settles any optimistic value.
  const reported = lane?.off.join(',')
  useEffect(() => setPending({}), [reported, sessionId])

  if (!source)
    return lane
      ? CONTEXT_FILE_KINDS.map((kind) => ({
          kind,
          state: contextFileToggleState(kind, true, lane, undefined, false),
        }))
      : null
  return CONTEXT_FILE_KINDS.map((kind) => ({
    kind,
    state: contextFileToggleState(kind, prefs[kind], lane, pending[kind]),
    toggle: (included: boolean) => {
      setPending((current) => ({ ...current, [kind]: included }))
      source.setRule(kind, included).catch((error: unknown) => {
        setPending((current) => ({ ...current, [kind]: undefined }))
        useExtensionUiStore
          .getState()
          .pushToast(
            `Couldn't change ${CONTEXT_FILE_LABELS[kind]}. ${ipcErrorText(error)}`,
            'error',
          )
      })
    },
  }))
}
