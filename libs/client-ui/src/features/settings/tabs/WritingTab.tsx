import { useEffect } from 'react'
import { Button, Row, SectionTitle, Toggle } from '@/components/form'
import { formatShortcut, hostPlatform } from '@/lib/shortcuts'
import { useWritingStore } from '@/stores/writing'

/** Spelling and autocomplete in Phosphor's text fields. Phosphor-local, no model involved. */
export function WritingTab(): React.JSX.Element {
  const prefs = useWritingStore((s) => s.prefs)
  const learned = useWritingStore((s) => s.learned)
  const setPrefs = useWritingStore((s) => s.setPrefs)

  useEffect(() => {
    void useWritingStore.getState().load()
  }, [])

  const wordKey = formatShortcut(hostPlatform() === 'darwin' ? 'alt' : 'ctrl', '→')

  return (
    <div>
      <SectionTitle>Writing</SectionTitle>

      <Row
        title="Check spelling"
        description="Underlines misspelled words in text fields. Right-click one for suggestions or to add it to your dictionary."
      >
        <Toggle on={prefs.spellcheck} onChange={(on) => void setPrefs({ spellcheck: on })} />
      </Row>

      <Row
        title="Autocomplete"
        description={`Suggests the rest of a word or phrase as you type in a composer, learned from the prompts you send from now on. Tab or → accepts it, ${wordKey} takes one word, Esc hides it. Runs on this computer; nothing is sent anywhere.`}
      >
        <Toggle on={prefs.autocomplete} onChange={(on) => void setPrefs({ autocomplete: on })} />
      </Row>

      <Row
        title="Learned prompts"
        description={
          learned === null
            ? 'Prompts autocomplete has kept on this computer.'
            : `${learned} ${learned === 1 ? 'prompt' : 'prompts'} kept on this computer, up to the last 2,000. Only kept while autocomplete is on.`
        }
      >
        <Button
          size="sm"
          disabled={!learned}
          onClick={() => void useWritingStore.getState().clearPrompts()}
        >
          Clear
        </Button>
      </Row>
    </div>
  )
}
