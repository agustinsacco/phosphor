import { useState } from 'react'
import { Button, Row, SectionTitle } from '@/components/form'
import { ConfigFileEditor, piConfigFile } from '../ConfigFileEditor'
import { useSettingsUiStore } from '../settingsUiStore'

/** Configuration belongs to Pi and its extension, never to a second runner. */
export function SubagentsTab(): React.JSX.Element {
  const [editing, setEditing] = useState(false)
  return (
    <div className="max-w-2xl text-base">
      <SectionTitle>Subagents</SectionTitle>
      <p className="text-text-secondary">
        Specialists inside your lane, powered by <code>pi-subagents</code>. The parent delegates,
        answers questions and reviews the result. Phosphor shows that work in the conversation; Pi
        owns execution. Installing the package does not authorize delegation.
      </p>

      <SectionTitle small>How delegation works</SectionTitle>
      <ol className="border-border divide-border divide-y rounded-lg border px-3">
        {[
          ['Delegate', 'The parent gives a specialist a bounded task and chooses its context.'],
          [
            'Work',
            'Foreground work streams into the tool row. Background work reports back later.',
          ],
          [
            'Coordinate',
            'A child can ask its parent for guidance. That is not automatically a question for you.',
          ],
          [
            'Review',
            'A finished run is evidence, not acceptance. The parent verifies it before claiming success.',
          ],
        ].map(([title, body], index) => (
          <li key={title} className="flex gap-3 py-3">
            <span aria-hidden="true" className="text-text-tertiary font-mono">
              0{index + 1}
            </span>
            <div>
              <strong className="font-medium">{title}</strong>
              <p className="text-text-secondary">{body}</p>
            </div>
          </li>
        ))}
      </ol>

      <SectionTitle small>Profiles and precedence</SectionTitle>
      <p className="text-text-secondary">
        Common roles include scout for recon, worker for implementation, reviewer for checks and
        oracle for advice. Available roles depend on your installed version and overrides. Ask the
        parent to list agents to see the resolved catalogue.
      </p>
      <p className="mt-2 text-text-secondary">
        Profiles are Markdown: YAML frontmatter defines the name, description, model and tools; the
        body is the system prompt. Same-name definitions resolve from project, then user, then
        installed packages, then builtins. Copy a profile into your own scope rather than editing an
        npm installation.
      </p>
      <dl className="mt-3 space-y-2">
        <div>
          <dt className="font-medium">Project</dt>
          <dd className="text-text-secondary break-all font-mono">.pi/agents/**/*.md</dd>
        </div>
        <div>
          <dt className="font-medium">User</dt>
          <dd className="text-text-secondary break-all font-mono">~/.pi/agent/agents/**/*.md</dd>
        </div>
      </dl>

      <SectionTitle small>Context and permissions</SectionTitle>
      <p className="text-text-secondary">
        Fresh context starts with the handoff; forked context carries parent history. Neither is a
        security sandbox. Tool allowlists limit agent capabilities, not operating-system access. Use
        isolated worktrees for independent writers and keep one writer per working directory.
      </p>

      <SectionTitle small>Configuration sources</SectionTitle>
      <Row
        title="Pi settings"
        description="Global defaults live under subagents in Pi settings. Project .pi/settings.json can override them. Restart sessions after editing."
      >
        <Button onClick={() => setEditing(true)}>Edit global settings…</Button>
      </Row>
      <p className="mt-2 text-text-secondary">
        For example, merge this into the existing <code>subagents</code> object to change the worker
        profile, without replacing unrelated settings:
      </p>
      <pre className="bg-code-bg mt-2 overflow-auto rounded-md p-3 font-mono text-sm">
        {JSON.stringify(
          { subagents: { agentOverrides: { worker: { defaultContext: 'fresh' } } } },
          null,
          2,
        )}
      </pre>
      <p className="mt-3 text-text-secondary">
        Runtime controls such as concurrency, timeouts, async defaults and retention belong to{' '}
        <code className="break-all">~/.pi/agent/extensions/subagent/config.json</code>, not Pi
        settings. A runtime <code>defaultSubagentContext</code> overrides profile context defaults;
        explicit launch context wins over both. Consult your installed version before changing keys.
      </p>
      <Row
        title="Delegation policy"
        description="Phosphor's authorization guidance lives with the other lane directives. It does not change extension configuration."
      >
        <Button
          onClick={() => useSettingsUiStore.getState().openResult('agent', 'Sub-agent policy')}
        >
          Open directives
        </Button>
      </Row>

      <SectionTitle small>Results and storage</SectionTitle>
      <p className="text-text-secondary">
        Child sessions, outputs and run artifacts are owned by the extension. Their paths appear
        with results; they can contain prompts, code and tool output. Keep the evidence you need
        before applying retention policies. Stopping a parent turn is not proof that detached
        children stopped. Resolve delegated work before restarting or deleting its lane.
      </p>
      <a
        className="text-text-secondary mt-4 inline-block underline underline-offset-2 hover:text-text"
        href="https://github.com/nicobailon/pi-subagents#readme"
        target="_blank"
        rel="noopener noreferrer"
        data-tooltip="Open link"
      >
        Package documentation
      </a>
      {editing && (
        <ConfigFileEditor source={piConfigFile('settings')} onClose={() => setEditing(false)} />
      )}
    </div>
  )
}
