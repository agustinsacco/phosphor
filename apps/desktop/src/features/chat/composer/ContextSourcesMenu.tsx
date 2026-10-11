import { useEffect, useMemo, useRef, useState } from 'react'
import clsx from 'clsx'
import {
  CONTEXT_FILE_KINDS,
  CONTEXT_FILE_LABELS,
  type ContextFileKind,
} from '@shared/context-files'
import { directToolsSummary } from '@shared/mcp'
import { ipcErrorText } from '@shared/errors'
import { formatTokens } from '@/lib/format'
import { PopupMenu } from '@/components/PopupMenu'
import { useContextFilesPrefStore } from '@/stores/contextFilesPref'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { useSettingsUiStore } from '@/features/settings/settingsUiStore'
import { useMcpServers } from '@/features/connectors/useMcpServers'
import { CONTEXT_BREAKDOWN_STATUS_KEY, parseContextBreakdown } from './contextBreakdown'
import { contextFileToggleState } from './contextFileToggle'

/**
 * What a lane loads besides the conversation: project rules (CLAUDE.md /
 * AGENTS.md) and MCP connectors, behind one chip in both composers.
 *
 * Rules: on the home composer they set what new lanes start with. Inside a
 * lane they change that lane from its next model request AND the starting
 * state of new lanes, so the last choice sticks. A lane's own state comes from
 * what its pi reports (`pi-ext/context-files.ts`), not from the preference,
 * which may have moved on since the lane started.
 *
 * Connectors: the servers' own `disabled` flag, as in Settings. The adapter
 * reads it when a lane starts, so inside a lane it says that it applies to
 * new lanes.
 */
export function ContextSourcesMenu({
  workspacePath,
  sessionId,
}: {
  workspacePath: string
  sessionId?: string
}): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const rules = useRuleToggles(sessionId)
  const mcp = useMcpServers(workspacePath)
  const servers = mcp.servers ?? []

  const rulesOn = rules.filter((rule) => rule.state.checked).length
  const label = `Rules ${rulesOn}/${rules.length}${servers.length > 0 ? ` · MCP ${mcp.enabled}/${servers.length}` : ''}`

  return (
    <div className="relative">
      <button
        ref={triggerRef}
        type="button"
        data-testid="context-sources"
        onClick={() => {
          if (!open) void mcp.refresh()
          setOpen((current) => !current)
        }}
        aria-expanded={open}
        title={
          sessionId
            ? 'Project rules and MCP connectors this lane loads'
            : 'Project rules and MCP connectors new lanes load'
        }
        className={clsx(
          'flex min-h-8 items-center rounded-md px-2 py-1 text-base tabular-nums transition-colors',
          open
            ? 'bg-bg-secondary text-text'
            : 'text-text-secondary hover:bg-bg-secondary hover:text-text',
        )}
      >
        {label}
      </button>
      {open && (
        <PopupMenu
          onClose={() => setOpen(false)}
          triggerRef={triggerRef}
          fitViewport
          className="absolute bottom-full left-0 mb-2 w-72 py-1"
        >
          <SectionHeading
            title="Project rules"
            note={sessionId ? 'from the next request' : 'new lanes'}
          />
          <div role="group" aria-label="Context files">
            {rules.map(({ kind, state, toggle }) => (
              <label key={kind} title={state.title} className={ROW_CLASS}>
                <input
                  type="checkbox"
                  checked={state.checked}
                  onChange={(event) => toggle(event.target.checked)}
                  className="accent-[var(--px-accent)]"
                />
                <span
                  className={clsx(
                    'min-w-0 flex-1 truncate',
                    state.missing ? 'text-text-tertiary' : 'text-text',
                    !state.checked && 'line-through',
                  )}
                >
                  {CONTEXT_FILE_LABELS[kind]}
                </span>
                <span className="text-text-tertiary shrink-0 font-mono text-sm tabular-nums">
                  {state.missing
                    ? 'none'
                    : state.tokens !== null
                      ? `~${formatTokens(state.tokens)}`
                      : ''}
                </span>
              </label>
            ))}
          </div>

          {servers.length > 0 && (
            <>
              <SectionHeading
                title="Connectors"
                note={sessionId ? 'new lanes; this lane keeps its own' : 'new lanes'}
                divided
              />
              <div className="max-h-60 overflow-y-auto" role="group" aria-label="Connectors">
                {servers.map((server) => {
                  const direct = directToolsSummary(server.config.directTools)
                  return (
                    <label key={server.name} className={ROW_CLASS}>
                      <input
                        type="checkbox"
                        checked={server.config.disabled !== true}
                        onChange={(event) => void mcp.setEnabled(server, event.target.checked)}
                        className="accent-[var(--px-accent)]"
                      />
                      <span className="text-text min-w-0 flex-1 truncate font-mono">
                        {server.name}
                      </span>
                      {direct && (
                        <span
                          className="text-warning shrink-0 text-sm"
                          title={`directTools (${direct}): these tools skip the mcp gateway and cost their full schema on every request. Change it in Settings → Connectors.`}
                        >
                          direct
                        </span>
                      )}
                    </label>
                  )
                })}
              </div>
              {mcp.error && <div className="text-danger px-3 py-1 text-sm">{mcp.error}</div>}
            </>
          )}

          <div className="border-border mt-1 border-t px-3 pt-1.5 pb-1">
            <button
              type="button"
              onClick={() => {
                setOpen(false)
                const settings = useSettingsUiStore.getState()
                settings.setTab('connectors')
                settings.setOpen(true)
              }}
              className="text-text-secondary hover:text-text text-sm"
            >
              Manage connectors…
            </button>
          </div>
        </PopupMenu>
      )}
    </div>
  )
}

const ROW_CLASS =
  'hover:bg-bg-secondary flex cursor-pointer items-center gap-2 px-3 py-1.5 text-base'

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

/** Each rule file's checkbox state, with the lane's report and an optimistic click folded in. */
function useRuleToggles(sessionId: string | undefined): Array<{
  kind: ContextFileKind
  state: ReturnType<typeof contextFileToggleState>
  toggle: (included: boolean) => void
}> {
  const prefs = useContextFilesPrefStore((s) => s.prefs)
  const statusText = useExtensionUiStore((s) =>
    sessionId ? s.statuses[sessionId]?.[CONTEXT_BREAKDOWN_STATUS_KEY] : undefined,
  )
  const lane = useMemo(() => parseContextBreakdown(statusText)?.contextFiles ?? null, [statusText])
  const [pending, setPending] = useState<Partial<Record<ContextFileKind, boolean>>>({})

  // The lane's next report settles any optimistic value.
  const reported = lane?.off.join(',')
  useEffect(() => setPending({}), [reported, sessionId])

  return CONTEXT_FILE_KINDS.map((kind) => ({
    kind,
    state: contextFileToggleState(kind, prefs[kind], lane, pending[kind]),
    toggle: (included: boolean) => {
      setPending((current) => ({ ...current, [kind]: included }))
      useContextFilesPrefStore
        .getState()
        .set(kind, included, sessionId)
        .catch((error: unknown) => {
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
