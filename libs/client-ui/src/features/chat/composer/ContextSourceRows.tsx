import { TooltipLabel } from '@/components/Tooltip'
import clsx from 'clsx'
import { CONTEXT_FILE_LABELS, type ContextFileKind } from '@shared/context-files'
import { formatTokens } from '@/lib/format'
import type { contextFileToggleState } from './contextFileToggle'

/** One rule kind's row: its state, and a toggle where the lane can change it. */
export interface RuleRow {
  kind: ContextFileKind
  state: ReturnType<typeof contextFileToggleState>
  toggle?: (included: boolean) => void
}

/** One connector's row: configured where the lane can change it, else connected in the lane. */
export interface ServerRow {
  name: string
  enabled: boolean
  direct: boolean
  tools: number | null | undefined
  toggle?: (on: boolean) => void
}

const ROW_CLASS = 'hover:bg-bg-secondary flex items-center gap-2 px-3 py-1.5 text-base'

/** A row's leading control: the checkbox where the lane can change it, else its state. */
function RowMark({
  checked,
  label,
  toggle,
}: {
  checked: boolean
  label?: string
  toggle?: (on: boolean) => void
}): React.JSX.Element {
  if (!toggle)
    return (
      <span role="img" aria-label={checked ? 'On' : 'Off'} className="w-3.5 shrink-0 text-center">
        {checked ? '✓' : ''}
      </span>
    )
  return (
    <input
      type="checkbox"
      checked={checked}
      aria-label={label}
      onChange={(event) => toggle(event.target.checked)}
      className="accent-[var(--px-accent)]"
      data-tooltip={label}
    />
  )
}

export function RuleRows({
  rules,
  sessionId,
}: {
  rules: RuleRow[]
  sessionId: string | undefined
}): React.JSX.Element {
  return (
    <>
      {rules.some((rule) => rule.toggle) && (
        <p className="text-text-tertiary px-3 py-1 text-sm">
          Each checkbox controls all files of that type, global and project.
        </p>
      )}
      <div className="max-h-60 overflow-y-auto" role="group" aria-label="Context files">
        {rules.map(({ kind, state, toggle }) => (
          <div key={kind}>
            <TooltipLabel
              data-tooltip={state.title}
              className={clsx(ROW_CLASS, toggle && 'cursor-pointer')}
            >
              <RowMark checked={state.checked} label={CONTEXT_FILE_LABELS[kind]} toggle={toggle} />
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
            </TooltipLabel>
            <RuleSources kind={kind} state={state} />
            {state.files === null && (
              <p className="text-text-tertiary px-3 pb-2 pl-9 text-sm">
                {sessionId
                  ? 'File details not yet reported by this lane.'
                  : 'Paths and scopes appear after a lane starts.'}
              </p>
            )}
          </div>
        ))}
      </div>
    </>
  )
}

/** The files of one rule kind the lane found, each with its scope and cost. */
function RuleSources({ kind, state }: Pick<RuleRow, 'kind' | 'state'>): React.JSX.Element | null {
  if (!state.files?.length) return null
  return (
    <ul className="space-y-2 px-3 pb-2 pl-9" aria-label={`${CONTEXT_FILE_LABELS[kind]} sources`}>
      {state.files.map((file) => (
        <li key={file.path} className="text-text-secondary text-sm">
          <div className="flex items-center justify-between gap-2">
            <span
              className="font-medium"
              data-tooltip={
                file.scope === 'global'
                  ? 'User instructions from pi’s agent directory, shared across projects.'
                  : file.scope === 'project'
                    ? 'Instructions from the working directory or an ancestor directory.'
                    : 'This lane’s extension has not reported the file’s scope.'
              }
            >
              {file.scope === 'global'
                ? 'Global'
                : file.scope === 'project'
                  ? 'Project'
                  : 'Scope unknown'}
            </span>
            <span className="text-text-tertiary">
              {state.checked ? 'Included' : 'Excluded'} · ~{formatTokens(file.tokens)}
            </span>
          </div>
          <div className="break-all font-mono text-xs" data-tooltip={file.path}>
            {file.path}
          </div>
        </li>
      ))}
    </ul>
  )
}

export function ServerRows({ servers }: { servers: ServerRow[] }): React.JSX.Element {
  return (
    <div className="max-h-60 overflow-y-auto" role="group" aria-label="Connectors">
      {servers.map(({ name, enabled, direct, tools, toggle }) => (
        <TooltipLabel key={name} className={clsx(ROW_CLASS, toggle && 'cursor-pointer')}>
          {toggle && <RowMark checked={enabled} toggle={toggle} />}
          <span className="text-text min-w-0 flex-1 truncate font-mono">{name}</span>
          {typeof tools === 'number' && (
            <span
              className="text-text-tertiary shrink-0 text-sm"
              data-tooltip="Connected in this lane"
            >
              {tools} tool{tools === 1 ? '' : 's'}
            </span>
          )}
          {direct && (
            <span
              className="text-warning shrink-0 text-sm"
              data-tooltip="Direct tools are declared on every request and cost their full schema each time. Change it in Settings → Connectors."
            >
              direct
            </span>
          )}
        </TooltipLabel>
      ))}
    </div>
  )
}
