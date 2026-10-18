import { Button } from '@/components/form'
import type { Dispatch, SetStateAction } from 'react'
import { ClaudeAccountRow } from './MachineClaudeAccountRow'
import type { ProviderSectionProps } from './MachineProviderSections'
import { Card } from './MachineUi'
export function ClaudeAccounts(
  props: ProviderSectionProps & {
    expanded: string | null
    setExpanded: Dispatch<SetStateAction<string | null>>
  },
): React.JSX.Element {
  const { state, busy, programs, label, expanded, setExpanded } = props
  const ids = state.accounts.map((account) => account.id)
  return (
    <Card
      title="Claude accounts"
      aside={
        <Button
          size="xs"
          disabled={
            busy || !programs.available || state.claude.cli !== 'ok' || state.accounts.length >= 16
          }
          onClick={() => programs.login('claude', { addAccount: true })}
        >
          Add account
        </Button>
      }
    >
      <ClaudeRouting {...props} ids={ids} />
      {state.authenticating && (
        <p role="status" className="text-info mb-3 text-base">
          Sign-in or verification is still running on {label}…
        </p>
      )}
      {!ids.length && (
        <p className="text-text-secondary text-base">
          No verified Claude accounts yet. Add an account to sign in on {label}.
        </p>
      )}
      <ul className="divide-border divide-y">
        {state.accounts.map((account, index) => (
          <ClaudeAccountRow
            key={account.id}
            {...props}
            {...{ account, index, ids, expanded, setExpanded }}
          />
        ))}
      </ul>
    </Card>
  )
}

function ClaudeRouting({
  state,
  busy,
  settings,
  ids,
}: ProviderSectionProps & { ids: string[] }): React.JSX.Element {
  return (
    <div className="mb-4 space-y-2">
      <label className="text-text-secondary flex flex-wrap items-center justify-between gap-3 text-base">
        <span>Account for new Claude lanes</span>
        <select
          aria-label="Claude account routing"
          className="border-border bg-bg rounded-md border px-2 py-1"
          disabled={busy || !ids.length}
          value={state.mode}
          onChange={(e) =>
            void settings.change({
              type: 'claude.routing',
              mode: e.target.value as typeof state.mode,
              ...(state.pinnedId
                ? { pinnedId: state.pinnedId }
                : ids[0]
                  ? { pinnedId: ids[0] }
                  : {}),
            })
          }
        >
          <option value="specific">Specific account</option>
          <option value="ordered">First available, in order</option>
          <option value="round-robin">Round-robin</option>
        </select>
      </label>
      {state.mode === 'specific' && ids.length > 0 && (
        <label className="text-text-secondary flex flex-wrap items-center justify-between gap-3 text-base">
          <span>Pinned account</span>
          <select
            aria-label="Pinned Claude account"
            value={state.pinnedId ?? ids[0]}
            disabled={busy}
            className="border-border bg-bg rounded-md border px-2 py-1"
            onChange={(e) =>
              void settings.change({
                type: 'claude.routing',
                mode: 'specific',
                pinnedId: e.target.value,
              })
            }
          >
            {state.accounts.map((a) => (
              <option key={a.id} value={a.id}>
                {a.label}
              </option>
            ))}
          </select>
        </label>
      )}
      <p className="text-text-tertiary text-sm">
        Chosen once when a lane starts. Ordered and round-robin routing skip accounts on cooldown.
        Resuming a lane keeps its original account; nothing switches mid-turn.
      </p>
    </div>
  )
}
