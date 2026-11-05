import clsx from 'clsx'
import { TooltipButton } from '@/components/Tooltip'
import { NumberField, Row, Select } from '@/components/form'
import { useSettingsStore } from '@/stores/settings'

const MONO_FONTS = ['JetBrains Mono', 'Fira Code', 'SF Mono', 'Menlo', 'Cascadia Code', 'monospace']

const THEME_OPTIONS = [
  { value: 'light', label: 'Light' },
  { value: 'dark', label: 'Dark' },
  { value: 'system', label: 'System' },
] as const

/** Device-local preferences supported by both the browser bridge and Desktop. */
export function AppearancePreferences(): React.JSX.Element {
  const fonts = useSettingsStore((s) => s.fonts)
  const setFonts = useSettingsStore((s) => s.setFonts)
  return (
    <>
      <ThemePreference />
      <Row title="Chat font size" description="Message text size in the conversation.">
        <label>
          <span className="sr-only">Chat font size</span>
          <NumberField
            value={fonts.chatFontSize}
            suffix="px"
            min={11}
            max={20}
            step={0.5}
            onChange={(v) => setFonts({ chatFontSize: v })}
          />
        </label>
      </Row>
      <Row
        title="Mono font"
        description="JetBrains Mono is bundled. Other choices use installed fonts."
      >
        <Select
          value={fonts.monoFont}
          options={MONO_FONTS.map((font) => ({ value: font, label: font }))}
          onChange={(monoFont) => setFonts({ monoFont })}
        />
      </Row>
    </>
  )
}

function ThemePreference(): React.JSX.Element {
  const theme = useSettingsStore((s) => s.theme)
  return (
    <Row title="Theme" description="Applies live to this app on this device.">
      <div
        className="border-border flex flex-wrap overflow-hidden rounded-lg border"
        role="group"
        aria-label="Theme"
      >
        {THEME_OPTIONS.map(({ value, label }) => (
          <TooltipButton
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
          </TooltipButton>
        ))}
      </div>
    </Row>
  )
}
