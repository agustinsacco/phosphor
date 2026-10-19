import { AppearancePreferences } from '../AppearancePreferences'
import { clampUiScale, UI_SCALE_MAX, UI_SCALE_MIN } from '@shared/models'
import { useSettingsStore } from '@/stores/settings'
import { formatShortcut } from '@/lib/shortcuts'
import { Row, SectionTitle, NumberField } from '@/components/form'

/** Theme, UI scale and font preferences (phosphor-local, not pi settings). */

export function AppearanceTab(): React.JSX.Element {
  const fonts = useSettingsStore((s) => s.fonts)
  const setFonts = useSettingsStore((s) => s.setFonts)

  return (
    <div>
      <SectionTitle>Appearance</SectionTitle>

      <AppearancePreferences />
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
    </div>
  )
}
