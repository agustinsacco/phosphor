import { TooltipButton } from '@/components/Tooltip'
import { useCallback, useEffect, useState } from 'react'
import clsx from 'clsx'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { Row, SectionTitle, NumberField, TextField, Toggle } from '@/components/form'
import type { ConfigFileHealth } from '@shared/models'
import { useSettingsUiStore } from '../settingsUiStore'
import { DirectivesSection } from './DirectivesSection'
import { ContextBudgetSection } from './ContextBudgetSection'
import { errorText } from '@shared/errors'

/** Agent defaults written into pi's own settings.json (global or per project). */

export function AgentTab(): React.JSX.Element {
  // The scope line's folder scope: null edits the global file, a folder its project override.
  const folder = useSettingsUiStore((s) => s.folder)
  const scope: 'global' | 'project' = folder ? 'project' : 'global'
  const [scoped, setScoped] = useState<{
    global: Record<string, unknown>
    project: Record<string, unknown> | null
  } | null>(null)
  const [health, setHealth] = useState<ConfigFileHealth | null>(null)
  const [saving, setSaving] = useState(false)

  const workspaceArg = folder ?? undefined

  const reload = useCallback((): void => {
    // Unmerged per-scope reads: the editor must show what each file actually
    // contains, or a project override would silently absorb inherited global
    // values on the next edit.
    void window.phosphor.invoke('pi:agentSettingsScoped', workspaceArg).then(setScoped)
    void window.phosphor.invoke('pi:checkAgentSettings', workspaceArg).then((result) => {
      setHealth(
        scope === 'global'
          ? result.global
          : (result.project ?? { exists: false, malformed: false }),
      )
    })
  }, [workspaceArg, scope])

  useEffect(() => reload(), [reload])

  const patch = async (partial: Record<string, unknown>): Promise<void> => {
    setSaving(true)
    try {
      await window.phosphor.invoke('pi:patchAgentSettings', scope, workspaceArg, partial)
      // Nested groups merge one level, as main writes them.
      const merge = (file: Record<string, unknown>): Record<string, unknown> => {
        const next = { ...file }
        for (const [key, value] of Object.entries(partial))
          next[key] =
            value && typeof value === 'object'
              ? { ...(file[key] as Record<string, unknown> | undefined), ...value }
              : value
        return next
      }
      setScoped((s) =>
        s === null
          ? s
          : scope === 'global'
            ? { ...s, global: merge(s.global) }
            : { ...s, project: merge(s.project ?? {}) },
      )
      useExtensionUiStore.getState().pushToast('Saved — applies to newly started sessions', 'info')
    } catch (error) {
      // Malformed existing config: main refuses to write rather than clobber it.
      useExtensionUiStore.getState().pushToast(errorText(error), 'error')
      reload()
    } finally {
      setSaving(false)
    }
  }

  const blocked = health?.malformed === true

  /** The active scope's own file contents (never merged). */
  const settings = scoped === null ? null : scope === 'global' ? scoped.global : scoped.project
  /** What the other scope would contribute — placeholder/fallback material. */
  const inherited = scope === 'project' ? (scoped?.global ?? {}) : {}

  const compaction = (settings?.compaction ?? {}) as Record<string, unknown>
  const retry = (settings?.retry ?? {}) as Record<string, unknown>
  const inheritedCompaction = (inherited.compaction ?? {}) as Record<string, unknown>
  const inheritedRetry = (inherited.retry ?? {}) as Record<string, unknown>
  /** Label for "no explicit value here": inherited value in project scope. */
  const fallbackLabel = (key: string): string => {
    const value = inherited[key]
    return typeof value === 'string' && value ? `inherits "${value}"` : '(pi default)'
  }

  return (
    <div>
      <SectionTitle>Agent defaults</SectionTitle>
      <p className="text-text-tertiary -mt-2 mb-4 text-base">
        Writes pi&apos;s <code className="font-mono">settings.json</code>. Changes apply to{' '}
        <b>new</b> sessions (pi reads config at spawn).{saving ? ' Saving…' : ''}
      </p>

      {blocked && (
        <div className="bg-danger-soft border-danger/30 mb-4 rounded-lg border px-3.5 py-3 text-base">
          <div className="text-danger font-medium">
            This {scope === 'global' ? 'global' : 'workspace'} settings.json is not valid JSON.
          </div>
          <div className="text-text-secondary mt-1 leading-relaxed">
            Editing is disabled so Phosphor cannot overwrite and lose your existing configuration.
            pi also ignores the broken file and falls back to its defaults.
            {health?.error ? ` (${health.error})` : ''}
          </div>
          <TooltipButton
            onClick={() => useSettingsUiStore.getState().setTab('advanced')}
            className="border-danger/40 text-danger hover:bg-danger/10 mt-2 rounded-md border px-2.5 py-1 text-sm font-medium transition-colors"
          >
            Fix it in Advanced →
          </TooltipButton>
        </div>
      )}

      <fieldset
        disabled={blocked}
        className={clsx('contents', blocked && 'pointer-events-none opacity-50')}
      >
        <Row title="Default model" description='e.g. "claude-sonnet-4-5" or a models.json id.'>
          <TextField
            defaultValue={(settings?.defaultModel as string) ?? ''}
            placeholder={fallbackLabel('defaultModel')}
            onCommit={(v) => void patch({ defaultModel: v || undefined })}
          />
        </Row>
        <Row
          title="Default provider"
          description='e.g. "anthropic", "openai", or a custom provider.'
        >
          <TextField
            defaultValue={(settings?.defaultProvider as string) ?? ''}
            placeholder={fallbackLabel('defaultProvider')}
            onCommit={(v) => void patch({ defaultProvider: v || undefined })}
          />
        </Row>
        <Row
          title="Default thinking level"
          description="off · minimal · low · medium · high · xhigh · max"
        >
          <select
            value={(settings?.defaultThinkingLevel as string) ?? ''}
            onChange={(e) => void patch({ defaultThinkingLevel: e.target.value || undefined })}
            className="border-border bg-surface text-text rounded-lg border px-2.5 py-1.5 text-base outline-none"
          >
            <option value="">{fallbackLabel('defaultThinkingLevel')}</option>
            {['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'].map((level) => (
              <option key={level} value={level}>
                {level}
              </option>
            ))}
          </select>
        </Row>
        <Row
          title="Hide thinking blocks"
          description="Collapse model reasoning out of the transcript."
        >
          <Toggle
            on={(settings?.hideThinkingBlock ?? inherited.hideThinkingBlock) === true}
            onChange={(on) => void patch({ hideThinkingBlock: on })}
          />
        </Row>
        <Row title="Steering delivery" description="How queued steering messages are injected.">
          <ModeSelect
            value={(settings?.steeringMode as string) ?? ''}
            fallback={fallbackLabel('steeringMode')}
            onChange={(v) => void patch({ steeringMode: v || undefined })}
          />
        </Row>
        <Row title="Follow-up delivery" description="How queued follow-ups are injected.">
          <ModeSelect
            value={(settings?.followUpMode as string) ?? ''}
            fallback={fallbackLabel('followUpMode')}
            onChange={(v) => void patch({ followUpMode: v || undefined })}
          />
        </Row>

        <SectionTitle small>Compaction</SectionTitle>
        <Row
          title="Auto-compaction"
          description="Compact context automatically near the window limit, or at the context budget below if that comes first."
        >
          <Toggle
            on={(compaction.enabled ?? inheritedCompaction.enabled) !== false}
            onChange={(on) => void patch({ compaction: { enabled: on } })}
          />
        </Row>
        <Row title="Reserve tokens" description="Headroom kept free for the model's response.">
          <NumberField
            value={Number(compaction.reserveTokens ?? inheritedCompaction.reserveTokens ?? 16384)}
            min={1024}
            max={131072}
            step={1024}
            onChange={(v) => void patch({ compaction: { reserveTokens: v } })}
          />
        </Row>
        <Row
          title="Keep recent tokens"
          description="Recent conversation preserved verbatim during compaction."
        >
          <NumberField
            value={Number(
              compaction.keepRecentTokens ?? inheritedCompaction.keepRecentTokens ?? 20000,
            )}
            min={1024}
            max={131072}
            step={1024}
            onChange={(v) => void patch({ compaction: { keepRecentTokens: v } })}
          />
        </Row>
      </fieldset>

      {/* A Phosphor pref, not settings.json: unscoped, and still editable
          while a broken file blocks the rows around it. */}
      <ContextBudgetSection />

      <fieldset
        disabled={blocked}
        className={clsx('contents', blocked && 'pointer-events-none opacity-50')}
      >
        <SectionTitle small>Auto-retry</SectionTitle>
        <Row
          title="Retry on transient errors"
          description="Overloaded / rate-limit / 5xx responses."
        >
          <Toggle
            on={(retry.enabled ?? inheritedRetry.enabled) !== false}
            onChange={(on) => void patch({ retry: { enabled: on } })}
          />
        </Row>
        <Row title="Max retries" description="Attempts before giving up.">
          <NumberField
            value={Number(retry.maxRetries ?? inheritedRetry.maxRetries ?? 3)}
            min={1}
            max={10}
            step={1}
            onChange={(v) => void patch({ retry: { maxRetries: v } })}
          />
        </Row>
        <Row title="Base delay (ms)" description="First retry delay; grows exponentially.">
          <NumberField
            value={Number(retry.baseDelayMs ?? inheritedRetry.baseDelayMs ?? 2000)}
            min={250}
            max={60000}
            step={250}
            onChange={(v) => void patch({ retry: { baseDelayMs: v } })}
          />
        </Row>
      </fieldset>

      <DirectivesSection />
    </div>
  )
}

function ModeSelect({
  value,
  fallback,
  onChange,
}: {
  value: string
  /** Label for the empty option: "(pi default)" or the inherited value. */
  fallback: string
  onChange: (v: string) => void
}): React.JSX.Element {
  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value)}
      className="border-border bg-surface text-text rounded-lg border px-2.5 py-1.5 text-base outline-none"
    >
      <option value="">{fallback}</option>
      <option value="one-at-a-time">one-at-a-time</option>
      <option value="all">all</option>
    </select>
  )
}
