import { useCallback, useEffect, useMemo, useState } from 'react'
import { DEFAULT_AGENT_DIRECTIVES } from '@shared/models'
import type { AgentDirectivePrefs } from '@shared/models'
import { Row, SectionTitle, Toggle } from '@/components/form'
import { useActiveWorkspace } from '@/stores/workspaces'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { errorText } from '@shared/errors'

/**
 * Settings for the directive stack: what Phosphor appends to a lane's system
 * prompt.
 *
 * Three things make this a setting rather than a constant.
 *
 * 1. The right contents depend on the model. Anthropic cut its frontier
 *    harness prompt by roughly 70-80% and the cut is frontier-only, so a fleet
 *    running a mix needs a lean profile and a fuller one.
 * 2. Enforcement differs by provider. The worktree guard and the charter reach
 *    the model on every provider, but only the native path can also *enforce*
 *    them at the tool boundary. On the Claude Code bridge they are advice.
 * 3. The composed result must be visible before it is sent. A prompt you
 *    cannot read is one you cannot debug, and this one is on every request for
 *    the life of the lane.
 */
export function DirectivesSection(): React.JSX.Element {
  const workspace = useActiveWorkspace()
  const [scope, setScope] = useState<'global' | 'project'>('global')
  const [global, setGlobal] = useState<AgentDirectivePrefs>(DEFAULT_AGENT_DIRECTIVES)
  const [byProject, setByProject] = useState<Record<string, AgentDirectivePrefs>>({})

  const reload = useCallback((): void => {
    void window.phosphor.invoke('app:getPrefs').then((prefs) => {
      setGlobal(prefs.agentDirectives)
      setByProject(prefs.agentDirectivesByProject)
    })
  }, [])

  useEffect(() => reload(), [reload])

  const override = workspace ? byProject[workspace] : undefined
  const editing = scope === 'project' ? (override ?? global) : global
  const usingOverride = scope === 'project' && override !== undefined

  const save = async (next: AgentDirectivePrefs | null): Promise<void> => {
    try {
      await window.phosphor.invoke(
        'app:setAgentDirectives',
        next,
        scope === 'project' ? (workspace ?? undefined) : undefined,
      )
      useExtensionUiStore.getState().pushToast('Saved — applies to newly started lanes', 'info')
      reload()
    } catch (error) {
      useExtensionUiStore.getState().pushToast(errorText(error), 'error')
    }
  }

  const patch = (partial: Partial<AgentDirectivePrefs>): void => {
    void save({ ...editing, ...partial })
  }

  // What actually goes out, assembled the same way main assembles it. Shown
  // rather than described: this is the only place the user can see the whole
  // of layer 2 at once.
  const preview = useMemo(() => {
    const blocks: string[] = []
    if (editing.worktreeGuard) {
      blocks.push(
        [
          '<phosphor_workspace>',
          'Working directory: <this lane’s worktree>',
          'This session runs in a git worktree. The repository’s main checkout is',
          'on a DIFFERENT branch. Resolve every relative path against the working',
          'directory above, and never shorten an absolute path back to the main',
          'checkout — files there belong to another branch and read with no error.',
          '</phosphor_workspace>',
        ].join('\n'),
      )
    }
    if (editing.laneCharter) {
      blocks.push(
        [
          '<phosphor_lane>',
          'This session is a LANE: one unit of work, on its own branch, that ends in a',
          'pull request. Not a scratch session.',
          'Branch: <this lane’s branch>',
          '- Commit your work on this branch as you go. Do not commit to the base branch.',
          '- Open a pull request when the work is done. That is how this lane closes.',
          '- Keep the change reviewable: aim under 400 changed lines and 20 files.',
          '- Phosphor runs typecheck, tests and lint itself when your turn settles …',
          '</phosphor_lane>',
        ].join('\n'),
      )
    }
    if (editing.subagentPolicy) {
      blocks.push(
        [
          '<phosphor_subagents>',
          'Sub-agents are available, and the synchronous form is the reliable one:',
          'run_in_background: false returns the findings inside this turn on every',
          'provider version. A backgrounded agent reports back only on pi-claude-cli',
          '0.4.14 or newer; on anything older it dies with the turn, findings lost.',
          '- Answer directly when you can. Reading a handful of files is not a fan-out.',
          '</phosphor_subagents>',
        ].join('\n'),
      )
    }
    if (editing.custom.trim()) blocks.push(editing.custom.trim())
    return blocks.join('\n\n')
  }, [editing])

  return (
    <div className="flex flex-col gap-3">
      <SectionTitle>Directives</SectionTitle>

      <div className="text-text-secondary text-sm leading-relaxed">
        What Phosphor appends to every lane&rsquo;s system prompt, in this order. Project rules
        files are a separate layer the agent reads as an ordinary message, with no guarantee it
        follows them; this one is part of the system prompt and survives compaction.
      </div>

      <div className="flex items-center gap-1.5">
        {(['global', 'project'] as const).map((option) => (
          <button
            key={option}
            onClick={() => setScope(option)}
            disabled={option === 'project' && !workspace}
            className={
              scope === option
                ? 'border-accent bg-accent-soft text-accent rounded-md border px-2.5 py-1 font-mono text-xs uppercase'
                : 'border-border text-text-secondary hover:border-border-strong disabled:opacity-40 rounded-md border px-2.5 py-1 font-mono text-xs uppercase'
            }
          >
            {option}
          </button>
        ))}
        {scope === 'project' && (
          <span className="text-text-tertiary ml-1 font-mono text-xs">
            {usingOverride ? 'overriding the global default' : 'inheriting the global default'}
          </span>
        )}
      </div>

      <Row
        title="Worktree guard"
        description="Tells a worktree lane that the main checkout is a different branch. Stops a class of confident wrong-branch answers."
      >
        <Toggle on={editing.worktreeGuard} onChange={(on) => patch({ worktreeGuard: on })} />
      </Row>

      <Row
        title="Lane charter"
        description="States that this is a lane, that it owns its branch, that it ends in a pull request, that the change stays reviewable, and that checks are run rather than claimed."
      >
        <Toggle on={editing.laneCharter} onChange={(on) => patch({ laneCharter: on })} />
      </Row>

      <Row
        title="Sub-agent policy"
        description="Asks for direct answers on small work, and run_in_background: false when delegating is genuinely warranted — a synchronous sub-agent returns inside the turn on any provider version, while a backgrounded one needs pi-claude-cli 0.4.14 or newer to report back at all."
      >
        <Toggle on={editing.subagentPolicy} onChange={(on) => patch({ subagentPolicy: on })} />
      </Row>

      <div className="flex flex-col gap-1.5">
        <div className="text-text text-base">Your own text</div>
        <div className="text-text-secondary text-sm">
          Appended last, so it can qualify either block above. Keep it short: every token here is
          spent on every request for the life of the lane.
        </div>
        <textarea
          value={editing.custom}
          onChange={(e) => setGlobalOrProject(e.target.value)}
          onBlur={() => patch({ custom: editing.custom })}
          rows={5}
          spellCheck={false}
          placeholder="e.g. Prefer small PRs. Never touch generated files under src/gen/."
          className="border-border focus:border-border-focus bg-bg text-text placeholder:text-text-tertiary rounded-lg border px-2.5 py-2 font-mono text-sm outline-none"
        />
      </div>

      <details className="border-border bg-bg-secondary rounded-lg border">
        <summary className="text-text-secondary cursor-pointer px-3 py-2 font-mono text-xs uppercase">
          What gets sent ({preview.length} chars)
        </summary>
        <pre className="text-text-secondary overflow-x-auto px-3 pb-3 font-mono text-xs leading-relaxed whitespace-pre-wrap">
          {preview || 'Nothing — both blocks are off and there is no custom text.'}
        </pre>
      </details>

      {usingOverride && (
        <button
          onClick={() => void save(null)}
          className="border-border text-text-secondary hover:border-border-strong self-start rounded-md border px-2.5 py-1 text-sm"
        >
          Clear this project&rsquo;s override
        </button>
      )}
    </div>
  )

  // Local edit before blur-save, so typing does not write a pref per keystroke.
  function setGlobalOrProject(custom: string): void {
    if (scope === 'project' && workspace) {
      setByProject((prev) => ({ ...prev, [workspace]: { ...editing, custom } }))
    } else {
      setGlobal((prev) => ({ ...prev, custom }))
    }
  }
}
