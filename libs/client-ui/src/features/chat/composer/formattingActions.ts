/** One source for the field keymap, visible controls and shortcut reference. */
export const FORMATTING_ACTIONS = [
  { action: 'bold', label: 'Bold', glyph: 'B', code: 'KeyB', shift: false },
  { action: 'italic', label: 'Italic', glyph: 'I', code: 'KeyI', shift: false },
  { action: 'inlineCode', label: 'Inline code', glyph: '`', code: 'KeyE', shift: false },
  { action: 'codeBlock', label: 'Code block', glyph: '</>', code: 'KeyC', shift: true },
  { action: 'toggleBullet', label: 'Bulleted list', glyph: '•', code: 'Digit8', shift: true },
  { action: 'toggleOrdered', label: 'Numbered list', glyph: '1.', code: 'Digit7', shift: true },
  { action: 'link', label: 'Insert link', glyph: 'Link', code: 'KeyK', shift: true },
] as const

export type FormattingAction = (typeof FORMATTING_ACTIONS)[number]['action']

export function formattingKeys(binding: { code: string; shift: boolean }): string[] {
  return ['mod', ...(binding.shift ? ['shift'] : []), binding.code.replace(/^(Key|Digit)/, '')]
}
