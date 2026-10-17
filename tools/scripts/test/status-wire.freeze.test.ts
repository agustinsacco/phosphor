import { describe, expect, it } from 'vitest'
import { SWARM_STATUS_KEY } from '../../../libs/pi-extensions/pi-ext/swarm'
import { LANE_RELOAD_STATUS_KEY } from '../../../libs/pi-extensions/pi-ext/lane-reload'
import { HEADROOM_STATUS_KEY } from '../../../libs/pi-extensions/pi-ext/headroom'
import { CONTEXT_BREAKDOWN_STATUS_KEY } from '../../../apps/desktop/src/features/chat/composer/contextBreakdown'
import { HEADROOM_STATUS_KEY as RENDERER_HEADROOM_KEY } from '../../../apps/desktop/src/features/chat/composer/headroomStatus'
import { RATE_LIMIT_STATUS_KEY } from '../../../apps/desktop/src/features/chat/composer/rateLimit'
import { SUBAGENTS_STATUS_KEY } from '../../../apps/desktop/src/features/chat/subagentStatus'
import {
  parseFleetWidget,
  SUBAGENT_ASYNC_WIDGET_KEY,
  SUBAGENT_INSPECT_WIDGET_KEY,
} from '../../../apps/desktop/src/features/chat/subagentRuns'
import { useExtensionUiStore } from '../../../apps/desktop/src/stores/extensionUi'
import fixture from './__fixtures__/status-wire.json'

// Runtime characterization uses public constants/parsers/store only, never pi or a provider.
describe('status wire runtime characterization', () => {
  it('preserves the lowercase status constants, including external Claude compatibility', () => {
    expect([
      SWARM_STATUS_KEY,
      CONTEXT_BREAKDOWN_STATUS_KEY,
      LANE_RELOAD_STATUS_KEY,
      HEADROOM_STATUS_KEY,
      RATE_LIMIT_STATUS_KEY,
      SUBAGENTS_STATUS_KEY,
    ]).toEqual(fixture.statuses.map(({ key }) => key))
    expect(RENDERER_HEADROOM_KEY).toBe(HEADROOM_STATUS_KEY)
    expect(SUBAGENT_ASYNC_WIDGET_KEY).toBe(fixture.asyncWidget.key)
    expect(SUBAGENT_INSPECT_WIDGET_KEY).toBe(fixture.structuredWidgets[1])
  })

  it('routes every status key unchanged and retracts only the named key', () => {
    const sessionId = 'status-wire-characterization'
    const store = useExtensionUiStore.getState()
    try {
      for (const { key } of fixture.statuses) {
        store.handleRequest(sessionId, {
          type: 'extension_ui_request',
          id: key,
          method: 'setStatus',
          statusKey: key,
          statusText: '{"wire":true}',
        })
      }
      expect(useExtensionUiStore.getState().statuses[sessionId]).toEqual(
        Object.fromEntries(fixture.statuses.map(({ key }) => [key, '{"wire":true}'])),
      )
      for (const { key } of fixture.statuses) {
        store.handleRequest(sessionId, {
          type: 'extension_ui_request',
          id: key,
          method: 'setStatus',
          statusKey: key,
        })
        expect(useExtensionUiStore.getState().statuses[sessionId]).not.toHaveProperty(key)
      }
    } finally {
      store.clearSession(sessionId)
    }
  })

  it('accepts the exact async widget prefix and rejects case changes', () => {
    const { prefix, kind, version } = fixture.asyncWidget
    const payload = JSON.stringify({ kind, version, generatedAt: 42, runs: [] })
    expect(parseFleetWidget([prefix + payload])).toEqual({
      generatedAt: 42,
      runs: [],
      omittedRuns: 0,
      incomplete: false,
      active: 0,
    })
    expect(parseFleetWidget([prefix.toLowerCase() + payload])).toBeNull()
    expect(parseFleetWidget([prefix + JSON.stringify({ kind, version: 2 })])).toBeNull()
  })
})
