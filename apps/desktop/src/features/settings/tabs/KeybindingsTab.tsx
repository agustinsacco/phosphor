import { SectionTitle } from '@/components/form'
import { formatShortcut, hostPlatform } from '@/lib/shortcuts'
import { clipboardModifiers } from '@/features/terminal/clipboardKeys'
import { FORMATTING_ACTIONS, formattingKeys } from '@/features/chat/composer/formattingActions'

/**
 * Static reference table of the keyboard shortcuts, grouped by where they
 * apply. Bindings that exist in Claude Code or Claude Desktop keep those
 * spellings — Esc Esc to rewind, ↑ for prompt history and ⌃O for verbose
 * output — so muscle memory carries over.
 */

export type Binding = [parts: string[], action: string]

const APP: Binding[] = [
  [['F6'], 'Focus composer / pane controls'],
  [['mod', 'N'], 'New session'],
  [['mod', 'K'], 'Command palette'],
  [['mod', 'P'], 'Go to file'],
  [['mod', 'F'], 'Find in session or artifact'],
  [['mod', 'shift', 'F'], 'Search in workspace files'],
  [['mod', 'B'], 'Toggle sidebar'],
  [['mod', '`'], 'Toggle terminal pane'],
  [['mod', 'shift', 'E'], 'Toggle files pane'],
  [['mod', 'shift', 'G'], 'Toggle changes pane'],
  [['mod', ','], 'Settings'],
  [['mod', '/'], 'This shortcut list'],
  [['mod', '+'], 'Zoom in'],
  [['mod', '-'], 'Zoom out'],
  [['mod', '0'], 'Reset zoom'],
]

const CHAT: Binding[] = [
  [['Enter'], 'Send prompt (steer while streaming)'],
  [['alt', 'Enter'], 'Queue follow-up while streaming'],
  [['mod', 'Enter'], 'Queue follow-up while streaming (alternative)'],
  [['shift', 'Enter'], 'Newline / continue list in composer'],
  [['mod', 'shift', 'X'], 'Expand / collapse focused composer'],
  [['mod', 'Z'], 'Undo input edit'],
  [['mod', 'shift', 'Z'], 'Redo input edit'],
  [['Tab / Shift+Tab'], 'Indent / outdent a list; otherwise move focus'],
  [['Esc'], 'Stop the agent / close overlays'],
  [['Esc Esc'], 'Rewind to an earlier message'],
  [['↑'], 'Previous prompt (empty composer)'],
  [['↓'], 'Next prompt'],
  [['ctrl', 'O'], 'Expand / collapse tool output'],
]

const EDITOR: Binding[] = [
  [['mod', 'S'], 'Save file in editor'],
  [['mod', 'alt', 'S'], 'Save all open files (Files pane)'],
  [['mod', 'W'], 'Close editor tab (Files pane)'],
  [['mod', 'shift', 'T'], 'Reopen closed editor tab (Files pane)'],
  [['ctrl', 'Tab'], 'Next editor tab (Shift reverses)'],
  [['mod', 'F'], 'Find in editor / terminal'],
]

/*
 * Terminal copy/paste is the one pair whose KEYS differ per platform, not just
 * their spelling: Ctrl+C has to stay SIGINT off macOS, so copy moves to
 * Ctrl+Shift+C there (see features/terminal/clipboardKeys.ts).
 */
function clipboardBindings(): Binding[] {
  const mod = clipboardModifiers(hostPlatform())
  return [
    [[...mod, 'C'], 'Copy terminal selection'],
    [[...mod, 'V'], 'Paste into terminal'],
  ]
}

/** Settings → Writing → Autocomplete. Taking one word is ⌥→ on macOS, Ctrl+→ elsewhere. */
function autocompleteBindings(): Binding[] {
  return [
    [['Tab / →'], 'Accept autocomplete suggestion'],
    [[hostPlatform() === 'darwin' ? 'alt' : 'ctrl', '→'], 'Accept one word of the suggestion'],
  ]
}

/** The tables this tab shows, in order. Settings search indexes the same ones. */
export function keybindingGroups(): Array<{ title: string; bindings: Binding[] }> {
  return [
    { title: 'App', bindings: APP },
    { title: 'Chat', bindings: [...CHAT, ...autocompleteBindings()] },
    {
      title: 'Formatting',
      bindings: FORMATTING_ACTIONS.map<Binding>((binding) => [
        formattingKeys(binding),
        binding.label,
      ]),
    },
    { title: 'Editor & terminal', bindings: [...EDITOR, ...clipboardBindings()] },
  ]
}

export function KeybindingsTab(): React.JSX.Element {
  return (
    <div className="space-y-5">
      <p className="text-text-secondary text-base">
        App navigation works from the composer; Go to file also works from the editor. Dialogs block
        app navigation; zoom still works. In a fullscreen pane, F6 focuses its exit control.
      </p>
      {keybindingGroups().map((group) => (
        <Group key={group.title} {...group} />
      ))}
    </div>
  )
}

function Group({ title, bindings }: { title: string; bindings: Binding[] }): React.JSX.Element {
  return (
    <div>
      <SectionTitle>{title}</SectionTitle>
      <div className="border-border divide-border divide-y overflow-hidden rounded-xl border">
        {bindings.map(([parts, action]) => (
          <div
            key={action}
            data-setting-row
            className="bg-surface flex items-center justify-between gap-4 px-4 py-2"
          >
            <span className="text-base">{action}</span>
            <kbd className="bg-bg-secondary border-border rounded-md border px-2 py-0.5 font-mono text-sm">
              {formatShortcut(...parts)}
            </kbd>
          </div>
        ))}
      </div>
    </div>
  )
}
