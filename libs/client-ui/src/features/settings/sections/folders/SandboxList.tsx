import { useState } from 'react'
import { TooltipButton } from '@/components/Tooltip'
import { Button, SectionTitle } from '@/components/form'
import { promptRenameSandbox } from '@/features/workspaces/promptRenameSandbox'
import { relativeTime } from '@/lib/time'
import { useWorkspacesStore } from '@/stores/workspaces'
import type { SandboxInfo } from '@shared/models'

/** This Mac's "No folder" scratch folders, listed apart from its folders. */
export function SandboxList(): React.JSX.Element {
  const sandboxes = useWorkspacesStore((s) => s.sandboxes)
  return (
    <>
      <SectionTitle small>Sandboxes</SectionTitle>
      <p className="text-text-tertiary mb-2 text-base">
        Scratch folders behind “No folder”, each given a random name you can change. An empty one is
        reused, so asking again lands you back in the same place until something is written there.
        Renaming moves the folder on disk and takes its chats along; deleting moves both to the
        Trash.
      </p>
      {sandboxes.length === 0 && <p className="text-text-tertiary text-base">No sandboxes yet.</p>}
      <div className="border-border divide-border divide-y overflow-hidden rounded-xl border">
        {sandboxes.map((sandbox) => (
          <SandboxRow key={sandbox.path} sandbox={sandbox} />
        ))}
      </div>
    </>
  )
}

/** One sandbox, with the delete behind a second click rather than a modal. */
function SandboxRow({ sandbox }: { sandbox: SandboxInfo }): React.JSX.Element {
  const [confirming, setConfirming] = useState(false)
  const [busy, setBusy] = useState(false)

  const del = async (): Promise<void> => {
    setBusy(true)
    // The store reports the outcome (including a refusal) as a toast.
    await useWorkspacesStore.getState().deleteSandbox(sandbox.path)
    setBusy(false)
    setConfirming(false)
  }

  return (
    <div className="bg-surface flex items-center gap-3 px-4 py-2.5">
      <span className="min-w-0 flex-1">
        <span className="block truncate text-lg font-medium">{sandbox.name}</span>
        {/* The path, like every folder row above. A sandbox IS its
            path — it is what rename moves and what the sidebar groups by —
            and leaving it out made two sandboxes with similar names
            indistinguishable here. */}
        <span className="text-text-tertiary block truncate text-sm">{sandbox.path}</span>
      </span>
      {/* Hidden mid-confirm so Cancel/Confirm are not crowded off the row. */}
      {!confirming && (
        <span className="text-text-tertiary shrink-0 whitespace-nowrap text-sm">
          {sandbox.itemCount === 0
            ? 'Empty'
            : `${sandbox.itemCount} item${sandbox.itemCount === 1 ? '' : 's'}`}
          {' · '}
          {relativeTime(sandbox.lastUsedAt)}
        </span>
      )}
      {confirming ? (
        <>
          <Button size="xs" onClick={() => setConfirming(false)} className="shrink-0">
            Cancel
          </Button>
          <Button
            size="xs"
            variant="danger"
            disabled={busy}
            onClick={() => void del()}
            className="shrink-0"
          >
            {busy ? 'Deleting…' : 'Confirm'}
          </Button>
        </>
      ) : (
        <>
          <TooltipButton
            onClick={() => void promptRenameSandbox(sandbox.path)}
            className="text-text-tertiary hover:text-text shrink-0 rounded-md px-1.5 py-1 text-sm transition-colors"
          >
            Rename
          </TooltipButton>
          <TooltipButton
            onClick={() => setConfirming(true)}
            className="text-text-tertiary hover:text-danger shrink-0 rounded-md px-1.5 py-1 text-sm transition-colors"
          >
            Delete
          </TooltipButton>
        </>
      )}
    </div>
  )
}
