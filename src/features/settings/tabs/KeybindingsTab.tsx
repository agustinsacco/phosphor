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

type Binding = [parts: string[], action: string]

const APP: Binding[] = [
  [['F6'], 'Focus composer / pane controls'],
  [['mod', 'N'], 'New session'],
  [['mod', 'K'], 'Command palette'],
  [['mod', 'P'], 'Go to file'],
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
  [['mod', 'F'], 'Search in terminal'],
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

export function KeybindingsTab(): React.JSX.Element {
  return (
    <div className="space-y-5">
      <p className="text-text-secondary text-base">
        App navigation works from the composer. Other editors keep their own letter chords. Dialogs
        block app navigation; zoom still works. In a fullscreen pane, F6 focuses its exit control.
      </p>
      <Group title="App" bindings={APP} />
      <Group title="Chat" bindings={CHAT} />
      <Group
        title="Formatting"
        bindings={FORMATTING_ACTIONS.map<Binding>((binding) => [
          formattingKeys(binding),
          binding.label,
        ])}
      />
      <Group title="Editor & terminal" bindings={[...EDITOR, ...clipboardBindings()]} />
    </div>
  )
}

function Group({ title, bindings }: { title: string; bindings: Binding[] }): React.JSX.Element {
  return (
    <div>
      <SectionTitle>{title}</SectionTitle>
      <div className="border-border divide-border divide-y overflow-hidden rounded-xl border">
        {bindings.map(([parts, action]) => (
          <div key={action} className="bg-surface flex items-center justify-between px-4 py-2">
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
