import { useState } from 'react'
import { Button, Row } from '@/components/form'
import { EditInstructions } from '../../instructions/EditInstructions'
import { RetiredDirectives } from '../../instructions/RetiredDirectives'
import { AGENT_ROW_TEXT } from './agentFields'
import { DirectiveToggles } from './DirectiveToggles'
import type { AgentSource } from './source'

/**
 * What a lane is told beyond pi's own prompt, in two layers owned differently:
 *
 * 1. Global instructions are the user's words: pi's global context file in
 *    the machine's agent directory, the one pi in a terminal reads too. Every
 *    lane reads it per request, so a save reaches running lanes at their next
 *    message.
 * 2. The directive blocks are Phosphor's words with per-lane facts in them,
 *    so they are switches, and the composed result is shown exactly as the
 *    session service builds it. They are fixed when a lane starts.
 */
export function AgentDirectives({
  source,
}: {
  source: Pick<AgentSource, 'directives' | 'instructions'>
}): React.JSX.Element | null {
  const { directives, instructions } = source
  const [editing, setEditing] = useState(false)
  if (!directives && !instructions) return null
  return (
    <div className="flex flex-col gap-3">
      {instructions && (
        <Row
          title={AGENT_ROW_TEXT.instructions.title}
          description={`Your own instructions for every agent on ${instructions.machine}: pi's global AGENTS.md, which lanes, routines, sub-agents and pi in a terminal all load. Running lanes use a save from their next message.`}
        >
          <Button size="sm" onClick={() => setEditing(true)}>
            Edit instructions
          </Button>
        </Row>
      )}
      {directives?.retired && (
        <RetiredDirectives
          retired={directives.retired.entries}
          onDismissed={directives.retired.dismissed}
        />
      )}
      {directives && (
        <>
          <div className="text-text-secondary text-sm leading-relaxed">
            What Phosphor appends to every lane&rsquo;s system prompt, in this order. These
            instructions guide the agent; tool guards provide enforcement. Changes apply to newly
            started lanes.
            {directives.override &&
              (directives.override.active
                ? ' This folder overrides the machine’s switches.'
                : ' This folder uses the machine’s switches until you change one here.')}
          </div>
          <DirectiveToggles
            value={directives.value}
            machine={directives.machine}
            disabled={directives.disabled}
            onChange={(patch) => directives.set({ ...directives.value, ...patch })}
          />
          {directives.override?.active && (
            <Button size="sm" className="self-start" onClick={directives.override.clear}>
              Clear this folder&rsquo;s override
            </Button>
          )}
        </>
      )}
      {editing && instructions && (
        <EditInstructions source={instructions} onClose={() => setEditing(false)} />
      )}
    </div>
  )
}
