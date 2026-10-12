import { TooltipButton } from '@/components/Tooltip'
import { useRef, useState } from 'react'
import clsx from 'clsx'
import { MenuRow, PopupMenu } from '@/components/PopupMenu'
import { CheckIcon, ChevronIcon } from '@/components/icons'
import { FAKE_MACHINES, localMachineName } from './fakeMachines'
import { MachineDot } from './MachineSidebar'

/**
 * Where a new lane will run, beside the folder chip on the home screen while
 * the Machines preview is on. Only this computer can be picked: starting a
 * lane on a Host needs Phosphor to reach it (component 21).
 */
export function RunOnPicker(): React.JSX.Element {
  const [open, setOpen] = useState(false)
  const triggerRef = useRef<HTMLButtonElement>(null)
  const local = localMachineName(window.phosphor.platform).long
  return (
    <span className="relative shrink-0">
      <TooltipButton
        ref={triggerRef}
        onClick={() => setOpen((o) => !o)}
        data-testid="run-on"
        aria-expanded={open}
        className={clsx(
          'border-border flex cursor-pointer items-center gap-1.5 rounded-lg border px-2.5 py-1 text-base font-medium transition-colors',
          open
            ? 'bg-bg-secondary text-text border-border-strong'
            : 'bg-surface text-text-secondary hover:text-text hover:border-border-strong',
        )}
      >
        <span className="text-text-tertiary">Run on</span>
        <span>{local}</span>
        <ChevronIcon size={10} className="text-text-tertiary" />
      </TooltipButton>
      {open && (
        <PopupMenu
          onClose={() => setOpen(false)}
          triggerRef={triggerRef}
          fitViewport
          className="absolute bottom-full left-0 z-40 mb-1.5 w-72 py-1.5"
        >
          <MenuRow active={false} onClick={() => setOpen(false)}>
            <MachineDot up />
            <span className="min-w-0 flex-1 truncate text-lg">{local}</span>
            <CheckIcon className="text-accent shrink-0" />
          </MenuRow>
          {FAKE_MACHINES.map((machine) => (
            <MenuRow
              key={machine.id}
              active={false}
              disabled
              onClick={() => undefined}
              title="Remote runs are not available in the preview"
            >
              <MachineDot up={machine.up} />
              <span className="min-w-0 flex-1 truncate text-lg">{machine.name}</span>
              <span className="text-text-tertiary shrink-0 text-sm">
                {machine.up ? 'preview' : 'down'}
              </span>
            </MenuRow>
          ))}
        </PopupMenu>
      )}
    </span>
  )
}
