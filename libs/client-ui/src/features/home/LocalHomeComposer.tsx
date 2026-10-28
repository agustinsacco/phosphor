import type { ReactNode, RefObject } from 'react'
import { StartComposer } from './StartComposer'
import { useLocalStart } from './useLocalStart'

/** This Mac's new-lane composer: the shared start composer over the workspace target. */
export function LocalHomeComposer({
  workspacePath,
  textareaRef,
  machinePicker,
}: {
  workspacePath: string
  textareaRef: RefObject<HTMLTextAreaElement | null>
  machinePicker: ReactNode
}): React.JSX.Element {
  const target = useLocalStart(workspacePath, textareaRef)
  return <StartComposer target={target} textareaRef={textareaRef} machinePicker={machinePicker} />
}
