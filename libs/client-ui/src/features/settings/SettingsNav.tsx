import { Fragment } from 'react'
import clsx from 'clsx'
import { TooltipButton } from '@/components/Tooltip'
import type { SettingsSection } from './settingsIndex'
import type { SettingsMachineChoice } from './SettingsMachineScope'
import type { SettingsMachine, SettingsTab } from './settingsUiStore'

/**
 * Device sections, then the Configure selector and the chosen machine's
 * sections. A column beside the panel; a scrolling strip above it when narrow.
 */
export function SettingsNav({
  sections,
  nested,
  selected,
  counts,
  choices,
  machine,
  onTab,
  onMachine,
}: {
  sections: readonly SettingsSection[]
  /** Installed extension tabs, listed under Extensions. */
  nested: readonly SettingsSection[]
  /** The open tab; null while search results are listed. */
  selected: SettingsTab | null
  counts: Map<SettingsTab, number> | null
  choices: readonly SettingsMachineChoice[]
  machine: SettingsMachineChoice | null
  onTab: (tab: SettingsTab) => void
  onMachine: (machine: SettingsMachine) => void
}): React.JSX.Element {
  const button = (section: SettingsSection, isNested = false): React.JSX.Element => (
    <NavButton
      key={section.id}
      label={section.label}
      nested={isNested}
      selected={
        selected === section.id ||
        (section.id === 'extensions' && nested.some((tab) => tab.id === selected))
      }
      count={counts ? (counts.get(section.id) ?? 0) : null}
      onClick={() => onTab(section.id)}
    />
  )
  const machineSections = sections.filter((section) => section.scope === 'machine')
  return (
    <nav
      aria-label="Settings sections"
      className="-mx-1 min-h-0 flex gap-0.5 overflow-x-auto px-1 md:mx-0 md:block md:flex-1 md:overflow-y-auto md:px-0"
    >
      {sections.filter((section) => section.scope === 'device').map((section) => button(section))}
      {machine && (
        <div className="flex shrink-0 items-center gap-2 px-2.5 md:mb-1 md:mt-3">
          <span
            aria-hidden="true"
            className="text-text-tertiary hidden font-mono text-xs font-semibold uppercase tracking-wider md:inline"
          >
            Configure
          </span>
          <select
            aria-label="Configure"
            value={machine.id}
            disabled={choices.length < 2}
            onChange={(event) => onMachine(event.target.value)}
            className="border-border bg-surface text-text min-w-0 max-w-40 flex-1 rounded-md border px-1.5 py-1 text-base"
          >
            {choices.map((choice) => (
              <option key={choice.id} value={choice.id}>
                {choice.label}
              </option>
            ))}
          </select>
        </div>
      )}
      {machineSections.map((section) => (
        <Fragment key={section.id}>
          {button(section)}
          {section.id === 'extensions' && nested.map((tab) => button(tab, true))}
        </Fragment>
      ))}
    </nav>
  )
}

/**
 * One sidebar entry. Nested entries (an extension's own tab) indent under
 * Extensions in the sidebar and sit inline in the narrow strip. While
 * searching, each shows its match count and dims without any.
 */
function NavButton({
  label,
  nested,
  selected,
  count,
  onClick,
}: {
  label: string
  nested: boolean
  selected: boolean
  count: number | null
  onClick: () => void
}): React.JSX.Element {
  return (
    <TooltipButton
      onClick={onClick}
      aria-current={selected ? 'page' : undefined}
      data-nested={nested || undefined}
      className={clsx(
        'flex shrink-0 items-center gap-2 whitespace-nowrap rounded-lg px-2.5 py-1.5 text-left transition-colors md:mb-0.5',
        nested
          ? 'md:border-border text-base md:ml-4 md:w-[calc(100%-1rem)] md:rounded-none md:border-l md:py-1 md:pl-3'
          : 'text-lg md:w-full',
        selected
          ? clsx('bg-bg-secondary text-text font-medium', nested && 'md:bg-transparent')
          : 'text-text-secondary hover:text-text',
        count === 0 && 'opacity-40',
      )}
    >
      {label}
      {count !== null && count > 0 && (
        <span
          aria-hidden="true"
          className="bg-accent-soft text-accent ml-auto rounded-full px-1.5 text-2xs font-medium tabular-nums"
        >
          {count}
        </span>
      )}
    </TooltipButton>
  )
}
