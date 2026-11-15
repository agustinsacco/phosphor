import { TooltipButton } from './Tooltip'
import { SearchIcon } from './icons'
import { usePaletteStore } from '@/features/palette/paletteStore'

export function PaletteButton(): React.JSX.Element {
  return (
    <TooltipButton
      title="Search lanes and pages"
      className="hit-slop flex h-8 w-8 shrink-0 items-center justify-center rounded-md"
      onClick={() => usePaletteStore.getState().setOpen(true)}
    >
      <SearchIcon size={18} />
    </TooltipButton>
  )
}
