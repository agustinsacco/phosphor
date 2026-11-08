import { useState } from 'react'
import type { BrainGraph as Graph, BrainSearchResult, BrainSnapshot } from '@shared/brain'
import { Button, TextInput } from '@/components/form'
import { BrainGraph } from './BrainGraph'
import { BrainInspector } from './BrainInspector'
import { formatBrainTime } from './brainTime'
import type { BrainAction } from './useBrain'

type ExploreProps = { snapshot: BrainSnapshot; busy: boolean; act: BrainAction }
export function BrainExplore({ snapshot, busy, act }: ExploreProps): React.JSX.Element {
  const [result, setResult] = useState<BrainSearchResult | null>(null)
  const [graph, setGraph] = useState<Graph | null>(null)
  const [selected, setSelected] = useState<string | null>(null)
  const claims = result ? result.results.map((r) => r.claim) : snapshot.claims.slice(0, 50)
  const claim = claims.find((c) => c.id === selected)
  return (
    <section aria-label="Explore Brain">
      <SearchForm
        busy={busy}
        act={act}
        onResult={(r) => {
          setResult(r)
          setSelected(null)
        }}
      />
      {result && (
        <p role="status">
          {result.status} · {result.results.length} result(s). {result.degradation.join(' · ')}{' '}
          {result.truncated ? 'Truncated results: refine your search.' : ''}
        </p>
      )}
      <BrainGraph
        graph={
          graph ?? {
            nodes: snapshot.entities,
            edges: snapshot.claims,
            truncated: snapshot.truncated,
          }
        }
        onEntity={(id) => {
          void act(async () => setGraph(await window.phosphor.invoke('brain:graph', id)))
        }}
      />
      <p>
        Snapshot includes enrolled branches. Entity exploration shows project-wide evidence only.
      </p>
      {graph && <Button onClick={() => setGraph(null)}>Show snapshot graph</Button>}
      <h2 className="font-semibold">Claims · accessible list</h2>
      {!claims.length && (
        <p>No reviewed claims match. Process enrolled evidence and review proposals in Activity.</p>
      )}
      {!result && snapshot.claims.length > 50 && (
        <p role="status">Truncated claim list: showing 50. Search to narrow results.</p>
      )}
      <ul>
        {claims.map((c) => (
          <li className="brain-card" key={c.id}>
            <Button aria-pressed={selected === c.id} onClick={() => setSelected(c.id)}>
              {c.summary}
            </Button>
            <p>
              {c.kind} · {c.state} ·{' '}
              {c.conflictIds.length
                ? `${c.conflictIds.length} conflict(s)`
                : 'no recorded conflicts'}
            </p>
            <p>
              Valid {formatBrainTime(c.validFrom)} → {formatBrainTime(c.validTo)} · recorded{' '}
              {formatBrainTime(c.recordedAt)}
            </p>
          </li>
        ))}
      </ul>
      {claim && (
        <BrainInspector
          key={`${claim.id}:${snapshot.graphRevision}:${snapshot.policyEpoch}`}
          claim={claim}
          entities={snapshot.entities}
          revision={{
            graphRevision: result?.graphRevision ?? snapshot.graphRevision,
            policyEpoch: result?.policyEpoch ?? snapshot.policyEpoch,
          }}
          busy={busy}
          act={act}
        />
      )}
    </section>
  )
}

function SearchForm({
  busy,
  act,
  onResult,
}: {
  busy: boolean
  act: BrainAction
  onResult: (result: BrainSearchResult) => void
}): React.JSX.Element {
  const [query, setQuery] = useState('')
  const [mode, setMode] = useState<'lexical' | 'hybrid'>('lexical')
  const [validAt, setValidAt] = useState('')
  const [knownAt, setKnownAt] = useState('')
  const [branch, setBranch] = useState('')
  return (
    <form
      className="brain-card"
      onSubmit={(e) => {
        e.preventDefault()
        void act(async () =>
          onResult(
            await window.phosphor.invoke('brain:search', {
              query,
              mode,
              limit: 50,
              branch: branch.trim() || undefined,
              validAt: validAt ? new Date(validAt).getTime() : undefined,
              knownAt: knownAt ? new Date(knownAt).getTime() : undefined,
            }),
          ),
        )
      }}
    >
      <label className="brain-field">
        Search reviewed memory
        <TextInput
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          required
          maxLength={2000}
        />
      </label>
      <label className="brain-field">
        Evidence branch · blank means project-wide only
        <TextInput
          aria-label="Evidence branch"
          value={branch}
          onChange={(e) => setBranch(e.target.value)}
          maxLength={200}
        />
      </label>
      <label className="brain-field">
        Search mode
        <select value={mode} onChange={(e) => setMode(e.target.value as 'lexical' | 'hybrid')}>
          <option value="lexical">Lexical · no embedding model needed</option>
          <option value="hybrid">Hybrid · local embeddings</option>
        </select>
      </label>
      <label className="brain-field">
        Valid at
        <input type="datetime-local" value={validAt} onChange={(e) => setValidAt(e.target.value)} />
      </label>
      <label className="brain-field">
        Known at
        <input type="datetime-local" value={knownAt} onChange={(e) => setKnownAt(e.target.value)} />
      </label>
      <Button type="submit" disabled={busy || !query.trim()}>
        Search
      </Button>
    </form>
  )
}
