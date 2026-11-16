import { create } from 'zustand'

export const usePaletteStore = create<{
  open: boolean
  setOpen: (open: boolean) => void
}>((set) => ({ open: false, setOpen: (open) => set({ open }) }))

export interface PaletteAction {
  id: string
  label: string
  hint?: string
  needsYou?: boolean
  run: () => void
}
