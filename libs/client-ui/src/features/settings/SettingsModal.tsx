import { TooltipButton } from '@/components/Tooltip'
import { ModalOverlay } from '@/components/Modal'
import { CloseIcon } from '@/components/icons'
import { useSettingsUiStore } from './settingsUiStore'
import { SettingsSurface } from './SettingsSurface'

/** Desktop's Settings: the shared surface in a dialog. */
export function SettingsModal(): React.JSX.Element | null {
  const open = useSettingsUiStore((s) => s.open)
  if (!open) return null
  const close = (): void => useSettingsUiStore.getState().setOpen(false)
  return (
    <ModalOverlay onClose={close} z={40}>
      <div
        role="dialog"
        aria-modal="true"
        aria-label="Settings"
        className="border-border bg-bg relative flex h-[86vh] w-[880px] max-w-[94vw] overflow-hidden rounded-2xl border shadow-2xl md:h-[78vh]"
      >
        <SettingsSurface title="Settings" asideClassName="pr-12" />
        <TooltipButton
          onClick={close}
          aria-label="Close settings"
          className="text-text-tertiary hover:text-text hover:bg-bg-secondary absolute right-4 top-4 flex h-7 w-7 items-center justify-center rounded-md transition-colors"
        >
          <CloseIcon size={14} />
        </TooltipButton>
      </div>
    </ModalOverlay>
  )
}
