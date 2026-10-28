import { useEffect, useState } from 'react'
import { Button, Row, SectionTitle, Toggle } from '@/components/form'
import { CONTROL_ROUTES, DEFAULT_CONTROL_URL } from '@shared/control-api'
import type { UsagePingSettings } from '@shared/usage-ping'

export const PRIVACY_URL = 'https://phosphor.saccolabs.com/privacy'

const BLOCKED: Record<NonNullable<UsagePingSettings['blocked']>, string> = {
  'dev-build': 'Development builds never send it.',
  environment: 'Off here: DO_NOT_TRACK or PHOSPHOR_NO_USAGE_PING is set.',
}

/** Desktop answers with the settings; the browser and an old main refuse or answer nothing. */
export async function readUsagePing(): Promise<UsagePingSettings | null> {
  const value = await window.phosphor.invoke('app:usagePing').catch(() => null)
  return value && typeof value === 'object' && 'enabled' in value ? value : null
}

/** Settings → Advanced → Privacy. Renders nothing where the ping doesn't exist. */
export function UsagePingSection(): React.JSX.Element | null {
  const [state, setState] = useState<UsagePingSettings | null>(null)
  const [showing, setShowing] = useState(false)
  useEffect(() => {
    let live = true
    void readUsagePing().then((value) => live && setState(value))
    return () => {
      live = false
    }
  }, [])
  if (!state) return null

  const setEnabled = (enabled: boolean) =>
    window.phosphor.invoke('app:setUsagePing', { enabled }).then(setState, async () => {
      // Show what main actually holds, not the switch position that failed.
      setState(await readUsagePing())
    })

  return (
    <>
      <SectionTitle>Privacy</SectionTitle>
      <Row
        title="Send an anonymous daily usage ping"
        description={
          'Once a day: the Phosphor version, OS, architecture, and whether this is the first ' +
          'ping this week or month. No ID, account, address or anything you work on. ' +
          (state.blocked ? BLOCKED[state.blocked] : '')
        }
      >
        <Toggle
          on={state.enabled && !state.blocked}
          disabled={state.blocked !== null}
          onChange={(on) => void setEnabled(on)}
        />
      </Row>
      <div className="flex gap-2 py-2">
        <Button onClick={() => setShowing(!showing)}>
          {showing ? 'Hide' : 'Show exactly what is sent'}
        </Button>
        <Button onClick={() => void window.phosphor.invoke('app:openExternal', PRIVACY_URL)}>
          Privacy policy
        </Button>
      </div>
      {showing && (
        <pre className="border-border bg-surface mb-2 overflow-x-auto rounded-lg border p-3 font-mono text-sm">
          {state.preview
            ? `POST ${DEFAULT_CONTROL_URL}${CONTROL_ROUTES.usagePing}\n\n${JSON.stringify(state.preview, null, 2)}`
            : 'Nothing to send from this build.'}
        </pre>
      )}
    </>
  )
}
