import type { Terminal } from '@xterm/xterm'

type Paste = { text: string; execute: boolean }
type Term = Pick<Terminal, 'modes' | 'onWriteParsed' | 'paste' | 'input' | 'focus'>

/** How long a shell's output must stay quiet before its paste mode counts as settled. */
export const PASTE_MODE_QUIET_MS = 300

/**
 * Resolves true once the shell turns bracketed paste on, or false once its
 * output has gone quiet without it. A cold zsh writes before its prompt and
 * enables the mode only with the prompt, so the first parsed output is too early.
 */
function bracketedPasteSettles(term: Term): Promise<boolean> {
  return new Promise((done) => {
    let timer: ReturnType<typeof setTimeout>
    const finish = (on: boolean) => {
      clearTimeout(timer)
      listener.dispose()
      done(on)
    }
    const listener = term.onWriteParsed(() => {
      if (term.modes.bracketedPasteMode) finish(true)
      else arm()
    })
    const arm = () => {
      clearTimeout(timer)
      timer = setTimeout(() => finish(false), PASTE_MODE_QUIET_MS)
    }
    arm()
  })
}

function paste(term: Term, { text, execute }: Paste): void {
  term.paste(text)
  // Enter is a keypress, not part of the bracketed paste payload.
  if (execute) term.input('\r', true)
  term.focus()
}

/**
 * "Run in terminal". Old Readline (including macOS system Bash) executes
 * pasted newlines, so multiline input from a shell without bracketed paste is
 * staged for review instead. `stage(null)` clears an earlier staged command.
 */
export function runInTerminal(
  term: Term,
  command: Paste,
  stage: (text: string | null) => void,
  current: () => boolean,
): void {
  if (command.execute || !/[\r\n]/.test(command.text) || term.modes.bracketedPasteMode) {
    stage(null)
    paste(term, command)
    return
  }
  void bracketedPasteSettles(term).then((on) => {
    if (!current()) return
    if (!on) return stage(command.text)
    stage(null)
    paste(term, command)
  })
}
