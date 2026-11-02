import { SettingsNotice } from '@/components/form'
import { JobOutput } from '../../JobOutput'
import type { ClaudeAccountsSource } from '../accounts/accountsModel'
import { ClaudeAccountsView } from './ClaudeAccountsView'
import { ClaudeHealth, ClaudeProof, ClaudeTroubleshooting } from './ClaudeHealth'

/**
 * Settings → Extensions → Claude Code, on every machine that can run it: the
 * pi-claude-cli provider's health (with Install where it is missing), the
 * Claude accounts and their routing, and the end-to-end proof.
 */
export function ClaudeProviderView({
  source,
}: {
  source: ClaudeAccountsSource
}): React.JSX.Element {
  const { status, caps, health } = source
  const reviewed = caps.install === 'task'
  return (
    <div className="max-w-2xl">
      <h2 className="text-xl font-semibold">Claude Code provider</h2>
      <p className="text-text-secondary mt-1 text-base">
        Routes model calls through the Claude Code CLI, billing your Claude Pro/Max plan. Claude
        models appear in the model picker under the <span className="font-mono">pi-claude-cli</span>{' '}
        provider.
      </p>
      {typeof status === 'object' && (
        <div className="mt-4">
          <SettingsNotice
            tone="danger"
            title={status.error}
            action={{ label: 'Try again', onClick: status.retry }}
          />
        </div>
      )}
      <ClaudeHealth
        health={health}
        reviewed={reviewed}
        busy={source.busy}
        onInstall={source.install}
        onUpdate={source.update}
      />
      {source.jobs.map((job, index) => (
        <JobOutput key={index} running={job.running} output={job.output} exitCode={job.exitCode} />
      ))}
      <ClaudeAccountsView source={source} />
      <p className="text-text-secondary mt-6 text-base">
        pi manages the system prompt, tools, conversation and compaction for Claude too, and holds
        Claude sessions to the same context budget as every other provider. Use the Agent section
        and the session menu for compaction settings.
      </p>
      {caps.proof && (
        <ClaudeProof
          job={source.proof}
          disabled={health.cli !== 'installed'}
          onTest={source.test}
        />
      )}
      <ClaudeTroubleshooting reviewed={reviewed} />
    </div>
  )
}
