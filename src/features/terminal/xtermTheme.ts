import type { ITheme } from '@xterm/xterm'

/**
 * xterm themes derived from the Phosphor tokens (docs/style-guide.md §Terminal).
 * Hex literals on purpose — xterm takes a JS object, not CSS vars; keep in
 * sync with --px-* in src/styles/index.css (incl. --px-terminal-bg).
 */
export function xtermTheme(resolved: 'light' | 'dark'): ITheme {
  if (resolved === 'dark') {
    return {
      // The dark terminal sits on --px-bg itself, cursor in Phosphor.
      background: '#1e1c18',
      foreground: '#ece7db',
      cursor: '#eca03d',
      cursorAccent: '#1e1c18',
      // Selection has to survive being blended over --px-bg: the old
      // #3d322066 landed within a few points of the background, so a drag
      // looked like nothing had been selected.
      selectionBackground: '#8a6a2f66',
      black: '#3a352c',
      red: '#dd7663',
      green: '#7fbe88',
      yellow: '#d8ab52',
      blue: '#82a9c9',
      magenta: '#c99ec4',
      cyan: '#8cc4ba',
      white: '#ece7db',
      brightBlack: '#7c766a',
      brightRed: '#e78d7d',
      brightGreen: '#97cf9f',
      brightYellow: '#e5bd6e',
      brightBlue: '#9abbd6',
      brightMagenta: '#d6b1d1',
      brightCyan: '#a3d2c9',
      brightWhite: '#ffffff',
    }
  }
  return {
    background: '#ffffff',
    foreground: '#26262a',
    cursor: '#b35c0f',
    cursorAccent: '#ffffff',
    selectionBackground: '#f6e9d4',
    black: '#26262a',
    red: '#bb4a3c',
    green: '#4c8a54',
    yellow: '#a8842e',
    blue: '#47708f',
    magenta: '#96608f',
    cyan: '#4f8d84',
    white: '#e4e4e7',
    brightBlack: '#66666e',
    brightRed: '#cc5a4a',
    brightGreen: '#5fa168',
    brightYellow: '#bd9739',
    brightBlue: '#5c88ab',
    brightMagenta: '#ab74a3',
    brightCyan: '#61a198',
    brightWhite: '#f7f7f8',
  }
}
