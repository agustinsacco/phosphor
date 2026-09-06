import clsx from 'clsx'
import { clampUiScale, UI_SCALE_MAX, UI_SCALE_MIN } from '@shared/models'
import { useSettingsStore } from '@/stores/settings'
import { formatShortcut } from '@/lib/shortcuts'
import { Row, SectionTitle, NumberField } from '@/components/form'

/** Theme, UI scale and font preferences (pidex-local, not pi settings). */

const THEME_OPTIONS = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
] as const

export function AppearanceTab(): React.JSX.Element {
  const theme = useSettingsStore((s) => s.theme)
  const fonts = useSettingsStore((s) => s.fonts)
  const setFonts = useSettingsStore((s) => s.setFonts)

  return (
    <div>
      <SectionTitle>Appearance</SectionTitle>

      <Row title="Theme" description="Applies live across chat, editor, terminal and diagrams.">
        <div
          className="border-border flex overflow-hidden rounded-lg border"
          role="group"
          aria-label="Theme"
        >
          {THEME_OPTIONS.map(({ value, label }) => (
            <button
              key={value}
              aria-pressed={theme === value}
              onClick={() => useSettingsStore.getState().setTheme(value)}
              className={clsx(
                'px-3 py-1.5 text-base font-medium transition-colors',
                theme === value
                  ? 'bg-accent text-accent-text'
                  : 'text-text-secondary hover:text-text',
              )}
            >
              {label}
            </button>
          ))}
        </div>
      </Row>

      <Row
        title="UI scale"
        description={`Zooms the whole interface — text, icons and spacing. ${formatShortcut('mod', '+')} / ${formatShortcut('mod', '-')} to nudge, ${formatShortcut('mod', '0')} to reset.`}
      >
        <NumberField
          value={Math.round(fonts.uiScale * 100)}
          suffix="%"
          min={UI_SCALE_MIN * 100}
          max={UI_SCALE_MAX * 100}
          step={5}
          onChange={(v) => setFonts({ uiScale: clampUiScale(v / 100) })}
        />
      </Row>
      <Row title="Chat font size" description="Message text size in the conversation.">
        <NumberField
          value={fonts.chatFontSize}
          suffix="px"
          min={11}
          max={20}
          step={0.5}
          onChange={(v) => setFonts({ chatFontSize: v })}
        />
      </Row>
      <Row
        title="Editor font size"
        description="Monaco editor and diffs. Applies live to open views."
      >
        <NumberField
          value={fonts.editorFontSize}
          suffix="px"
          min={10}
          max={20}
          step={0.5}
          onChange={(v) => setFonts({ editorFontSize: v })}
        />
      </Row>
      <Row title="Terminal font size" description="Applies live to open terminal tabs.">
        <NumberField
          value={fonts.terminalFontSize}
          suffix="px"
          min={10}
          max={20}
          step={0.5}
          onChange={(v) => setFonts({ terminalFontSize: v })}
        />
      </Row>
      <Row
        title="Mono font"
        description="JetBrains Mono is bundled. Other choices use installed fonts."
      >
        <select
          value={fonts.monoFont}
          onChange={(e) => setFonts({ monoFont: e.target.value })}
          className="border-border bg-surface text-text rounded-lg border px-2.5 py-1.5 text-base outline-none"
        >
          {['JetBrains Mono', 'Fira Code', 'SF Mono', 'Menlo', 'Cascadia Code', 'monospace'].map(
            (font) => (
              <option key={font} value={font}>
                {font}
              </option>
            ),
          )}
        </select>
      </Row>
    </div>
  )
}
