import { useCallback, useEffect, useState } from 'react'
import { Button } from '@/components/form'
import { CatalogueCards } from '@/features/settings/CatalogueCards'
import { usePackageJob } from '@/features/settings/usePackageJob'
import { JobOutput } from '@/features/settings/JobOutput'

/**
 * One-time step after Phosphor itself installed pi: recommend providers and
 * curated extensions before entering the app. Everything here is reachable
 * again later via Settings → Extensions / Agent.
 */
export function GettingStartedScreen({ onDone }: { onDone: () => void }): React.JSX.Element {
  const [installedSpecs, setInstalledSpecs] = useState<string[]>([])
  const [claudeDetected, setClaudeDetected] = useState<boolean | null>(null)

  const refresh = useCallback(async (): Promise<void> => {
    try {
      const [list, detect] = await Promise.all([
        window.phosphor.invoke('packages:list'),
        window.phosphor.invoke('packages:detect'),
      ])
      setInstalledSpecs(list.map((entry) => entry.spec))
      setClaudeDetected(detect.claude)
    } catch {
      // Recommendations are best-effort on a machine that just got pi.
    }
  }, [])

  useEffect(() => {
    void refresh()
  }, [refresh])

  const job = usePackageJob(() => void refresh())

  return (
    <div className="titlebar-drag flex h-full flex-col items-center justify-center px-8">
      <div className="bg-surface border-border w-full max-w-2xl overflow-y-auto rounded-lg border p-8 shadow-sm">
        <h1 className="text-3xl font-semibold tracking-tight">pi is ready</h1>
        <p className="text-text-secondary mt-2 text-lg leading-relaxed">
          Two things make it useful: a model provider and, optionally, some extensions.
        </p>

        <h2 className="mt-6 text-lg font-semibold">Connect a provider</h2>
        <p className="text-text-secondary mt-1 text-base leading-relaxed">
          Subscriptions (ChatGPT/Codex, Claude Pro/Max, GitHub Copilot, xAI, OpenRouter): run{' '}
          <code className="bg-code-bg rounded px-1 font-mono text-base">pi</code> in a terminal and
          type <code className="bg-code-bg rounded px-1 font-mono text-base">/login</code>. API keys
          (Anthropic, OpenAI, Google, …) work via environment variables or Settings → Agent. Tokens
          are shared with Phosphor automatically.
        </p>

        <h2 className="mt-6 text-lg font-semibold">Recommended extensions</h2>
        <div className="mt-2.5">
          <CatalogueCards
            installedSpecs={installedSpecs}
            claudeDetected={claudeDetected}
            busy={job.running}
            onInstall={(spec) =>
              void job.start(() =>
                window.phosphor.invoke('packages:run', 'install', spec, 'global', undefined),
              )
            }
          />
        </div>
        <JobOutput running={job.running} output={job.output} exitCode={job.exitCode} />

        <div className="mt-7 flex justify-end">
          <Button variant="primary" size="lg" onClick={onDone} disabled={job.running}>
            Continue
          </Button>
        </div>
      </div>
    </div>
  )
}
