import type { BrainIdentity, BrainProposalView } from '@shared/brain'
import { Button, Segmented, Select, Tag } from '@/components/form'
import { TooltipSummary } from '@/components/Tooltip'
import { ReviewPage } from './ReviewSections'

const suggested = (identity: BrainIdentity): string =>
  identity.decision === 'reuse' && identity.entityId ? identity.entityId : 'new'
export function ReviewIdentities({
  proposal,
  overrides,
  onChange,
}: {
  proposal: BrainProposalView
  overrides: Record<string, string>
  onChange: (value: Record<string, string>) => void
}): React.JSX.Element {
  const matches = proposal.identities.filter((identity) => identity.decision === 'reuse')
  const fresh = proposal.identities.filter((identity) => identity.decision !== 'reuse')
  const row = (identity: BrainIdentity): React.JSX.Element => (
    <IdentityRow
      key={identity.ref}
      identity={identity}
      value={overrides[identity.ref] ?? suggested(identity)}
      onChange={(value) => onChange({ ...overrides, [identity.ref]: value })}
    />
  )
  return (
    <section aria-label="Who/what is this?" className="space-y-3">
      {matches.length > 0 && (
        <>
          <header className="flex flex-wrap items-center justify-between gap-2">
            <h3 className="font-medium">Needs your call · {matches.length}</h3>
            <IdentityActions identities={proposal.identities} onChange={onChange} />
          </header>
          <div className="border-border bg-surface rounded-lg border">
            <ReviewPage>{matches.map(row)}</ReviewPage>
          </div>
        </>
      )}
      {fresh.length > 0 && (
        <details>
          <TooltipSummary>{fresh.length} new people and things · no decision needed</TooltipSummary>
          <div className="mt-3 space-y-3">
            {fresh.some((identity) => identity.candidates.length) && (
              <div className="border-border bg-surface rounded-lg border">
                <ReviewPage>
                  {fresh.filter((identity) => identity.candidates.length).map(row)}
                </ReviewPage>
              </div>
            )}
            <div className="flex flex-wrap gap-2">
              {fresh
                .filter((identity) => !identity.candidates.length)
                .map((identity) => (
                  <span key={identity.ref} className="bg-bg-secondary rounded-md px-2 py-1 text-sm">
                    {identity.label} · {identity.kind}
                  </span>
                ))}
            </div>
          </div>
        </details>
      )}
    </section>
  )
}
function IdentityRow({
  identity,
  value,
  onChange,
}: {
  identity: BrainIdentity
  value: string
  onChange: (value: string) => void
}): React.JSX.Element {
  const candidate = identity.candidates.find((entry) => entry.id === value)
  const options = [
    { value: 'new', label: 'New' },
    ...identity.candidates.map((entry) => ({
      value: entry.id,
      label: `${entry.label} · ${entry.kind}`,
    })),
  ]
  return (
    <article className="min-w-0 space-y-2 p-3">
      <p className="flex flex-wrap items-center gap-2">
        <span className="font-medium">{identity.label}</span>
        <Tag>{identity.kind}</Tag>
        {identity.auto && <Tag>auto</Tag>}
      </p>
      <p className="text-text-tertiary text-sm">{identity.reason}</p>
      {identity.candidates.length === 1 ? (
        <Segmented
          label={`Identity for ${identity.label}`}
          value={value}
          onChange={onChange}
          options={[
            {
              value: identity.candidates[0]!.id,
              label: `Same as ${identity.candidates[0]!.label}`,
            },
            { value: 'new', label: 'New' },
          ]}
        />
      ) : (
        <Select
          className="w-full"
          label={`Identity for ${identity.label}`}
          value={value}
          onChange={onChange}
          options={options}
        />
      )}
      {candidate?.description && (
        <p className="text-text-secondary text-sm">{candidate.description}</p>
      )}
    </article>
  )
}

function IdentityActions({
  identities,
  onChange,
}: {
  identities: BrainIdentity[]
  onChange: (value: Record<string, string>) => void
}): React.JSX.Element {
  return (
    <div className="flex flex-wrap gap-2">
      <Button
        size="xs"
        onClick={() =>
          onChange(
            Object.fromEntries(identities.map((identity) => [identity.ref, suggested(identity)])),
          )
        }
      >
        Accept all
      </Button>
      <Button
        size="xs"
        onClick={() =>
          onChange(Object.fromEntries(identities.map((identity) => [identity.ref, 'new'])))
        }
      >
        All new
      </Button>
    </div>
  )
}
