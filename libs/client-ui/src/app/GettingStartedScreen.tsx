import { Button } from '@/components/form'
import { StandardPackages } from '@/features/settings/sections/extensions/StandardPackages'
import { useLocalPackages } from '@/features/settings/sections/extensions/useLocalPackages'

/**
 * One-time step after Phosphor itself installed pi: recommend providers and
 * curated extensions before entering the app. Everything here is reachable
 * again later via Settings → Extensions / Agent.
 */
export function GettingStartedScreen({ onDone }: { onDone: () => void }): React.JSX.Element {
  // Recommendations are best-effort on a machine that just got pi: a failed read lists none,
  // and nothing here shows a registry version.
  const source = useLocalPackages(null, { versions: false })

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
          <StandardPackages
            packages={source.packages ?? []}
            claudeCli={source.claudeCli}
            busy={source.busy}
            onInstall={(spec) => source.run('install', spec, 'global')}
          />
        </div>
        {source.output}

        <div className="mt-7 flex justify-end">
          <Button variant="primary" size="lg" onClick={onDone} disabled={source.busy}>
            Continue
          </Button>
        </div>
      </div>
    </div>
  )
}
