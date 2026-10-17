import { machineReadGeneration } from '@/stores/machineReadGeneration'
import { MachinePicker } from '@/features/machines/MachinePicker'
import { useMachinePagesStore, pageMachine } from '@/stores/machinePages'
import {
  useMachineCataloguesStore,
  machineCatalogueKey,
  EMPTY_MACHINE_CATALOGUE,
} from '@/stores/machineCatalogues'
import { TooltipButton, TooltipSummary } from '@/components/Tooltip'
import { memo, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import clsx from 'clsx'
import type { ResolvedSkill, SkillImportPreview, SkillScope } from '@shared/skills'
import { parseSkillFrontmatter, setSkillDraftFlag } from '@shared/skills'
import { SKILL_CATALOG, type SkillCatalogLibrary } from '@shared/skillsCatalog'
import { useSkillsStore } from '@/stores/skills'
import { promptChoice } from '@/stores/prompt'
import { useRemoteLanesStore, REMOTE_UNAVAILABLE } from '@/stores/remoteLanes'
import { PageShell } from '@/components/PageShell'
import { PaneTitle } from '@/components/PaneShell'
import { ModalOverlay } from '@/components/Modal'
import { Button, TextInput } from '@/components/form'
import { Markdown } from '@/components/markdown/Markdown'
import { NewSkillModal } from './NewSkillModal'
import { groupSkills } from './skillGroups'

/**
 * Global Skills page: outcome-first discovery with evidence and fit before
 * installation, plus a Yours inventory grouped by where skills live.
 * Installed state comes from `skills:list`; mutations refresh from main.
 *
 * A page, not a right pane: skills are global/project state with no tie to
 * any session, so this renders over the whole main region and works from the
 * home screen too (the pane version needed a live session to exist at all).
 */
export const SkillsPage = memo(function SkillsPage({
  workspacePath,
}: {
  workspacePath: string
}): React.JSX.Element {
  const filter = useRemoteLanesStore((s) => s.filter)
  const choice = useMachinePagesStore((s) => s.skillsMachine)
  const machine = pageMachine(filter, choice)
  const hosts = useRemoteLanesStore((s) => s.hosts)
  const generation = useRemoteLanesStore(() => machineReadGeneration(machine))
  const catalogue = useMachineCataloguesStore(
    (s) => s.catalogues[machineCatalogueKey(machine, generation)] ?? EMPTY_MACHINE_CATALOGUE,
  )
  const selectedWorkspace =
    machine === 'local'
      ? workspacePath.startsWith('host:')
        ? ''
        : workspacePath
      : `host:${machine}/machine`
  useEffect(() => {
    void useMachineCataloguesStore
      .getState()
      .load(machine === 'local' ? null : machine, selectedWorkspace)
  }, [machine, generation, selectedWorkspace])
  return (
    <SkillsInventory
      key={selectedWorkspace}
      workspacePath={selectedWorkspace}
      machinePicker={
        <MachinePicker
          value={machine}
          capability="skills.read"
          onChange={(id) => {
            useSkillsStore.getState().select(null)
            useMachinePagesStore.setState({ skillsMachine: id })
          }}
        />
      }
      catalogue={
        machine !== 'local' &&
        hosts[machine]?.state === 'ready' &&
        hosts[machine]?.capabilities.includes('skills.read') ? (
          <details className="px-3 py-2">
            <TooltipSummary>Models and providers on this machine</TooltipSummary>
            {catalogue.error && <p role="alert">{catalogue.error}</p>}
            {catalogue.providers.map((p) => (
              <p key={p.id}>
                {p.name}:{' '}
                {p.status === 'ready'
                  ? 'Signed in'
                  : p.status === 'not_ready'
                    ? 'Not signed in'
                    : 'Unknown'}
              </p>
            ))}
            {catalogue.models.map((m) => (
              <p key={`${m.provider}/${m.id}`}>
                {m.name} · {m.provider}
              </p>
            ))}
          </details>
        ) : null
      }
    />
  )
})

const SkillsInventory = memo(function SkillsInventory({
  workspacePath,
  machinePicker,
  catalogue,
}: {
  workspacePath: string
  machinePicker: ReactNode
  catalogue: ReactNode
}): React.JSX.Element {
  const remote = workspacePath.startsWith('host:')
  const available = useRemoteLanesStore((s) => {
    const host = s.hosts[workspacePath.slice(5).split('/')[0] ?? '']
    return host?.state === 'ready' && host.capabilities.includes('skills.read')
  })
  const result = useSkillsStore((s) => s.byWorkspace[workspacePath])
  const loading = useSkillsStore((s) => s.loading[workspacePath] ?? false)
  const error = useSkillsStore((s) => s.error[workspacePath])
  const tab = useSkillsStore((s) => s.tab)
  const selectedDir = useSkillsStore((s) => s.selectedDir)
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const [importPreview, setImportPreview] = useState<SkillImportPreview | null>(null)

  useEffect(() => {
    if (!remote) void useSkillsStore.getState().refresh(workspacePath)
  }, [workspacePath, remote])

  const skills = useMemo(() => result?.skills ?? [], [result])
  const selected = skills.find((skill) => skill.dir === selectedDir)

  const pickImport = async (): Promise<void> => {
    const preview = await window.phosphor.invoke('skills:importPick')
    if (preview) setImportPreview(preview)
  }

  return (
    <PageShell
      title={<PaneTitle label="Skills" meta={result ? `${skills.length}` : undefined} />}
      actions={
        <div className="flex items-center gap-1.5">
          {machinePicker}
          {remote ? (
            <span>Read-only</span>
          ) : (
            <>
              <Button size="sm" onClick={() => void pickImport()}>
                Upload
              </Button>
              <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
                New skill
              </Button>
            </>
          )}
        </div>
      }
    >
      {/* Centered column: a page spans the whole main region, and list rows
          stretched across an ultrawide window stop reading as rows. */}
      <div className="mx-auto flex h-full min-h-0 w-full max-w-4xl flex-col">
        {catalogue}
        {remote && !available ? (
          <p className="p-4">{REMOTE_UNAVAILABLE}</p>
        ) : selected ? (
          <SkillDetail
            key={`${workspacePath}:${selected.dir}`}
            skill={selected}
            workspacePath={workspacePath}
            onBack={() => useSkillsStore.getState().select(null)}
          />
        ) : (
          <>
            <div className="flex items-center gap-2 px-3 pb-2">
              {!remote && (
                <Segmented
                  value={tab}
                  options={[
                    { id: 'discover', label: 'Discover' },
                    { id: 'yours', label: `Yours${result ? ` · ${skills.length}` : ''}` },
                  ]}
                  onChange={(next) => useSkillsStore.getState().setTab(next)}
                />
              )}
              <TextInput
                size="sm"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search skills"
                className="min-w-0 flex-1"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
              {remote || tab === 'yours' ? (
                <>
                  {!remote && <BundledSkillNotice workspacePath={workspacePath} />}
                  <YoursList
                    skills={skills}
                    search={search}
                    loading={loading}
                    error={error}
                    probe={result?.probe}
                  />
                </>
              ) : (
                <DiscoverList skills={skills} search={search} workspacePath={workspacePath} />
              )}
            </div>
          </>
        )}
      </div>
      {!remote && creating && (
        <NewSkillModal
          workspacePath={workspacePath}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false)
            void useSkillsStore.getState().refresh(workspacePath)
          }}
        />
      )}
      {!remote && importPreview && (
        <ImportSheet
          preview={importPreview}
          workspacePath={workspacePath}
          onClose={() => setImportPreview(null)}
          onImported={() => {
            setImportPreview(null)
            void useSkillsStore.getState().refresh(workspacePath)
          }}
        />
      )}
    </PageShell>
  )
})

function BundledSkillNotice({ workspacePath }: { workspacePath: string }): React.JSX.Element {
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)
  const restore = async (): Promise<void> => {
    setBusy(true)
    setFailure(null)
    try {
      await window.phosphor.invoke('skills:restoreBundled')
      await useSkillsStore.getState().refresh(workspacePath)
    } catch (error) {
      setFailure(error instanceof Error ? error.message : String(error))
    } finally {
      setBusy(false)
    }
  }
  return (
    <div className="border-border mb-3 border-b pb-3 text-sm">
      <p>
        Phosphor includes visual-artifacts. Edit its Source or hide/delete it like any user skill.
        Updates preserve your copy. Restore only reinstalls a missing folder.
      </p>
      <Button size="sm" disabled={busy} onClick={() => void restore()}>
        Restore artifact skill
      </Button>
      {failure && (
        <p role="alert" className="text-danger">
          {failure}
        </p>
      )}
    </div>
  )
}

function Segmented<T extends string>({
  value,
  options,
  onChange,
}: {
  value: T
  options: Array<{ id: T; label: string }>
  onChange: (next: T) => void
}): React.JSX.Element {
  return (
    <div className="border-border flex shrink-0 overflow-hidden rounded-md border">
      {options.map((option) => (
        <TooltipButton
          key={option.id}
          onClick={() => onChange(option.id)}
          aria-pressed={option.id === value}
          className={clsx(
            'cursor-pointer px-2.5 py-1 text-base transition-colors',
            option.id === value
              ? 'bg-bg-secondary text-text font-medium'
              : 'text-text-secondary hover:text-text',
          )}
        >
          {option.label}
        </TooltipButton>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Yours

function matches(skill: ResolvedSkill, search: string): boolean {
  const needle = search.trim().toLowerCase()
  if (!needle) return true
  return (
    skill.name.toLowerCase().includes(needle) || skill.description.toLowerCase().includes(needle)
  )
}

function YoursList({
  skills,
  search,
  loading,
  error,
  probe,
}: {
  skills: ResolvedSkill[]
  search: string
  loading: boolean
  error: string | undefined
  probe: 'rpc' | 'scan' | undefined
}): React.JSX.Element {
  const visible = skills.filter((skill) => matches(skill, search))
  const ordered = groupSkills(visible)
  if (error) return <EmptyNote text={`Could not list skills: ${error}`} />
  if (loading && skills.length === 0) return <EmptyNote text="Resolving skills…" />
  if (visible.length === 0) {
    return <EmptyNote text={search ? 'No skills match.' : 'No skills yet — try Discover.'} />
  }
  return (
    <div>
      {probe === 'scan' && (
        <div className="text-text-tertiary pb-2 text-sm">
          pi could not be asked directly — this list is a scan of the known skill folders.
        </div>
      )}
      {ordered.map(([label, group]) => (
        <div key={label} className="pb-2">
          <div className="text-text-tertiary pt-1 pb-1 font-mono text-xs font-semibold tracking-wider uppercase">
            {label}
          </div>
          {group.map((skill) => (
            <SkillRow key={skill.dir} skill={skill} />
          ))}
        </div>
      ))}
    </div>
  )
}

function updateAvailable(skill: ResolvedSkill): boolean {
  if (!skill.provenance) return false
  const library = SKILL_CATALOG.find((entry) => entry.id === skill.provenance!.catalogId)
  return !!library && library.sha !== skill.provenance.sha
}

function SkillRow({ skill }: { skill: ResolvedSkill }): React.JSX.Element {
  return (
    <TooltipButton
      onClick={() => useSkillsStore.getState().select(skill.dir)}
      className="hover:bg-bg-secondary block w-full cursor-pointer rounded-md px-2 py-1.5 text-left"
      title={skill.dir}
    >
      <span className="flex items-center gap-2">
        <span className="truncate font-mono text-base font-medium">{skill.name}</span>
        {skill.draft && <Tag tone="amber">draft</Tag>}
        {updateAvailable(skill) && <Tag tone="blue">update available</Tag>}
        {skill.warnings.length > 0 && <Tag tone="amber">{skill.warnings.length} ⚠</Tag>}
      </span>
      <span className="text-text-tertiary block truncate text-sm">
        {skill.description || 'No description'}
      </span>
    </TooltipButton>
  )
}

function Tag({
  tone,
  children,
}: {
  tone: 'blue' | 'amber' | 'neutral'
  children: React.ReactNode
}): React.JSX.Element {
  return (
    <span
      className={clsx(
        'shrink-0 rounded-full border px-1.5 text-xs whitespace-nowrap',
        tone === 'blue' && 'border-accent/40 text-accent',
        tone === 'amber' && 'border-warning/40 text-warning',
        tone === 'neutral' && 'border-border text-text-tertiary',
      )}
    >
      {children}
    </span>
  )
}

function EmptyNote({ text }: { text: string }): React.JSX.Element {
  return <div className="text-text-tertiary px-2 py-6 text-center text-sm">{text}</div>
}

// ---------------------------------------------------------------------------
// Detail

function SkillDetail({
  skill,
  workspacePath,
  onBack,
}: {
  skill: ResolvedSkill
  workspacePath: string
  onBack: () => void
}): React.JSX.Element {
  const [view, setView] = useState<'preview' | 'source' | 'files'>('preview')
  const [file, setFile] = useState('SKILL.md')
  const [content, setContent] = useState<string | null>(null)
  const [pending, setPending] = useState<string | null>(null)
  const deleting = useRef(false)
  const [failure, setFailure] = useState<string | null>(null)
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')

  useEffect(() => {
    setContent(null)
    let alive = true
    void window.phosphor.invoke('skills:readFile', skill.dir, file).then(
      (read) => {
        if (alive) setContent(read.binary ? null : read.content)
      },
      () => {
        if (alive) setContent(null)
      },
    )
    return () => {
      alive = false
    }
  }, [skill, file])

  const run = async (label: string, action: () => Promise<unknown>): Promise<void> => {
    setPending(label)
    setFailure(null)
    try {
      await action()
      await useSkillsStore.getState().refresh(workspacePath)
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setPending(null)
    }
  }

  const toggleDraft = (): Promise<void> =>
    run(skill.draft ? 'publish' : 'draft', async () => {
      const read = await window.phosphor.invoke('skills:readFile', skill.dir, 'SKILL.md')
      if (read.content == null) throw new Error('SKILL.md is not editable')
      await window.phosphor.invoke(
        'skills:writeFile',
        skill.dir,
        'SKILL.md',
        setSkillDraftFlag(read.content, !skill.draft),
        workspacePath,
      )
    })

  const update = (): Promise<void> =>
    run('update', async () => {
      const provenance = skill.provenance
      if (!provenance) return
      const library = SKILL_CATALOG.find((entry) => entry.id === provenance.catalogId)
      if (!library) return
      const skillName = provenance.subpath.split('/').pop() ?? skill.name
      await window.phosphor.invoke('skills:install', library.id, skillName, {
        targetName: skill.dir.split('/').pop(),
        overwrite: true,
      })
    })

  const remove = async (): Promise<void> => {
    if (deleting.current || pending != null) return
    deleting.current = true
    setPending('delete')
    setFailure(null)
    try {
      const choice = await promptChoice({
        title: `Move ${skill.name} to Trash?`,
        message: `The entire skill bundle at ${skill.dir} will move to the system Trash.`,
        choices: [{ value: 'trash', label: 'Move to Trash', primary: true }],
      })
      if (choice !== 'trash') return
      await window.phosphor.invoke('skills:delete', skill.dir, workspacePath)
      onBack()
      await useSkillsStore.getState().refresh(workspacePath)
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause))
    } finally {
      deleting.current = false
      setPending(null)
    }
  }

  const body = useMemo(
    () => (content != null ? parseSkillFrontmatter(content).body : null),
    [content],
  )

  return (
    <div className="flex h-full min-h-0 flex-col px-3 pb-3">
      <div className="flex items-center gap-2 pb-1">
        <TooltipButton
          onClick={onBack}
          disabled={editing}
          className="text-text-secondary hover:text-text cursor-pointer text-base"
        >
          ← Skills
        </TooltipButton>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-lg font-semibold">{skill.name}</span>
        <Tag tone="neutral">{skill.scope}</Tag>
        {skill.borrowed && <Tag tone="neutral">claude code</Tag>}
        {skill.origin === 'package' && <Tag tone="neutral">{skill.source}</Tag>}
        {skill.draft && <Tag tone="amber">draft</Tag>}
      </div>
      <div
        className="text-text-tertiary truncate pt-0.5 font-mono text-xs"
        data-tooltip={skill.dir}
      >
        {skill.dir} · {skill.files.length} files · {formatSize(skill.totalSize)}
      </div>
      {skill.warnings.length > 0 && (
        <div className="text-warning pt-1 text-sm">
          {skill.warnings.map((warning) => (
            <div key={warning}>⚠ {warning}</div>
          ))}
        </div>
      )}
      <div className="flex flex-wrap items-center gap-1.5 pt-2 pb-1">
        {(['preview', 'source', 'files'] as const).map((id) => (
          <TooltipButton
            key={id}
            onClick={() => setView(id)}
            disabled={editing}
            className={clsx(
              'cursor-pointer rounded-md px-2 py-0.5 text-base capitalize',
              view === id ? 'bg-bg-secondary text-text font-medium' : 'text-text-secondary',
            )}
          >
            {id}
          </TooltipButton>
        ))}
        <span className="flex-1" />
        {skill.writable && view === 'source' && content !== null && !editing && (
          <Button
            size="sm"
            onClick={() => {
              setDraft(content)
              setEditing(true)
            }}
          >
            Edit source
          </Button>
        )}
        {skill.writable && (
          <Button
            size="sm"
            disabled={pending != null || editing}
            onClick={() => void toggleDraft()}
          >
            {skill.draft ? 'Publish' : 'Hide from model'}
          </Button>
        )}
        {updateAvailable(skill) && (
          <Button
            size="sm"
            variant="primary"
            disabled={pending != null || editing}
            onClick={() => void update()}
          >
            Update
          </Button>
        )}
        {!workspacePath.startsWith('host:') && (
          <Button
            size="sm"
            disabled={pending != null}
            onClick={() =>
              void run('export', () => window.phosphor.invoke('skills:export', skill.dir))
            }
          >
            Export
          </Button>
        )}
        {skill.writable && (
          <Button
            size="sm"
            variant="danger"
            disabled={pending != null || editing}
            onClick={() => void remove()}
          >
            Delete
          </Button>
        )}
      </div>
      {failure && (
        <div role="alert" className="text-danger pb-1 text-sm">
          {failure}
        </div>
      )}
      {skill.writable && (
        <p className="text-text-tertiary pb-2 text-sm">
          Availability and skill descriptions refresh in new sessions or after /reload. Artifact
          help reads saved content on its next call.
        </p>
      )}
      {editing && (
        <div className="flex gap-2 pb-2">
          <Button
            size="sm"
            disabled={pending != null}
            onClick={() =>
              void run('save', async () => {
                await window.phosphor.invoke(
                  'skills:writeFile',
                  skill.dir,
                  file,
                  draft,
                  workspacePath,
                )
                setContent(draft)
                setEditing(false)
              })
            }
          >
            Save source
          </Button>
          <Button size="sm" disabled={pending != null} onClick={() => setEditing(false)}>
            Cancel edit
          </Button>
        </div>
      )}
      <div className="border-border min-h-0 flex-1 overflow-y-auto rounded-lg border p-3">
        {view === 'files' ? (
          <div className="space-y-0.5">
            {skill.files.map((entry) => (
              <TooltipButton
                key={entry.path}
                onClick={() => {
                  setFile(entry.path)
                  setView('source')
                }}
                className="hover:bg-bg-secondary flex w-full cursor-pointer justify-between rounded px-1.5 py-0.5 text-left font-mono text-sm"
              >
                <span className="truncate">{entry.path}</span>
                <span className="text-text-tertiary shrink-0 pl-3">{formatSize(entry.size)}</span>
              </TooltipButton>
            ))}
          </div>
        ) : content == null ? (
          <div className="text-text-tertiary text-sm">
            {file}: not a text file, or still loading.
          </div>
        ) : view === 'preview' ? (
          <Markdown text={body ?? content} />
        ) : editing ? (
          <textarea
            aria-label={`Edit ${file}`}
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            className="bg-bg text-text h-full min-h-64 w-full resize-y font-mono text-sm"
            spellCheck={false}
          />
        ) : (
          <pre className="font-mono text-sm leading-relaxed whitespace-pre-wrap">{content}</pre>
        )}
      </div>
      {view === 'source' && file !== 'SKILL.md' && (
        <div className="text-text-tertiary pt-1 font-mono text-xs">{file}</div>
      )}
    </div>
  )
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
}

// ---------------------------------------------------------------------------
// Discover

function DiscoverList({
  skills,
  search,
  workspacePath,
}: {
  skills: ResolvedSkill[]
  search: string
  workspacePath: string
}): React.JSX.Element {
  const [category, setCategory] = useState('All outcomes')
  const categories = ['All outcomes', 'Build & debug', 'Audit & verify', 'Data & optimization']
  const visible = SKILL_CATALOG.filter(
    (library) =>
      (category === 'All outcomes' || library.offering?.category === category) &&
      `${library.label} ${library.blurb} ${JSON.stringify(library.offering ?? {})} ${library.skills.map((skill) => `${skill.name} ${skill.description}`).join(' ')}`
        .toLowerCase()
        .includes(search.trim().toLowerCase()),
  )
  return (
    <div className="space-y-4">
      <header className="border-border border-b py-5">
        <p className="text-text-secondary font-mono text-xs tracking-wider uppercase">
          Capability workbench
        </p>
        <h1 className="mt-2 text-3xl font-semibold">What should your agent do better?</h1>
        <p className="text-text-secondary mt-2 max-w-xl text-lg">
          Start with a job, not a collection. Choose a focused skill, inspect its evidence, and keep
          only what helps your work.
        </p>
        <div className="text-text-secondary mt-4 flex flex-wrap gap-x-5 gap-y-1 font-mono text-sm">
          <span>01 · Find a fit</span>
          <span>02 · Check the evidence</span>
          <span>03 · Add deliberately</span>
        </div>
      </header>
      <div className="flex flex-wrap gap-2" aria-label="Skill outcomes">
        {categories.map((item) => (
          <TooltipButton
            key={item}
            aria-pressed={category === item}
            onClick={() => setCategory(item)}
            className={clsx(
              'cursor-pointer rounded-full border px-3 py-1.5 text-base',
              category === item
                ? 'border-accent bg-accent-soft text-text'
                : 'border-border text-text-secondary hover:text-text',
            )}
          >
            {item}
          </TooltipButton>
        ))}
      </div>
      <p className="text-text-secondary text-base">
        Evidence is a starting point, not a guarantee. Catalog skills are never installed
        automatically. Add installs into your global pi skills folder for all workspaces. Skills can
        guide the model and ship scripts it may run; dependencies are not installed.
      </p>
      {visible.length === 0 && (
        <EmptyNote text="No matches in this outcome. Try another filter or search." />
      )}
      {visible.map((library) => (
        <LibrarySection
          key={library.id}
          library={library}
          skills={skills}
          search={search}
          workspacePath={workspacePath}
        />
      ))}
    </div>
  )
}

function LibrarySection({
  library,
  skills,
  search,
  workspacePath,
}: {
  library: SkillCatalogLibrary
  skills: ResolvedSkill[]
  search: string
  workspacePath: string
}): React.JSX.Element | null {
  const [busy, setBusy] = useState<string | null>(null)
  const [failure, setFailure] = useState<string | null>(null)
  const offering = library.offering
  const needle = search.trim().toLowerCase()
  const libraryMatch = `${library.label} ${library.blurb} ${JSON.stringify(offering ?? {})}`
    .toLowerCase()
    .includes(needle)
  const visible = library.skills.filter(
    (entry) => libraryMatch || `${entry.name} ${entry.description}`.toLowerCase().includes(needle),
  )

  const installedNames = new Set(
    skills
      .filter((skill) => skill.provenance?.catalogId === library.id)
      .map((skill) => skill.provenance!.subpath.split('/').pop()),
  )

  const install = async (name: string): Promise<void> => {
    setBusy(name)
    setFailure(null)
    try {
      await window.phosphor.invoke('skills:install', library.id, name)
      await useSkillsStore.getState().refresh(workspacePath)
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause))
    } finally {
      setBusy(null)
    }
  }

  return (
    <article className="border-border bg-surface overflow-hidden rounded-xl border p-4">
      {offering && (
        <>
          <div className="text-text-secondary flex flex-wrap justify-between gap-2 font-mono text-xs uppercase tracking-wider">
            <span>{offering.category}</span>
            <span>{offering.evidence}</span>
          </div>
          <h2 className="mt-2 text-2xl font-semibold">{offering.goal}</h2>
          <p className="text-text-secondary text-sm">{library.label}</p>
          <p className="text-text-secondary mt-1 text-lg">{offering.fit}</p>
          <div className="border-border my-4 grid gap-3 border-y py-3 sm:grid-cols-2">
            <div>
              <h3 className="text-base font-semibold">The evidence</h3>
              <p className="text-text-secondary mt-1 text-base">{offering.result}</p>
            </div>
            <div>
              <h3 className="text-base font-semibold">The limits</h3>
              <p className="text-text-secondary mt-1 text-base">{offering.caveat}</p>
            </div>
          </div>
          <TooltipButton
            className="text-text-secondary cursor-pointer text-base underline hover:text-text"
            onClick={() => void window.phosphor.invoke('app:openExternal', offering.evidenceUrl)}
          >
            Read evaluation ↗
          </TooltipButton>
        </>
      )}
      <details className="mt-2" open={needle ? true : undefined}>
        <TooltipSummary className="text-text cursor-pointer py-2 text-base font-medium">
          {offering
            ? offering.external
              ? 'Compatibility & setup'
              : 'Review & choose skills'
            : library.label}
          <span className="text-text-secondary ml-2 font-normal">
            {offering?.external
              ? 'External plugin'
              : `${library.skills.length} skill${library.skills.length === 1 ? '' : 's'}`}
          </span>
        </TooltipSummary>
        {offering && <p className="text-text-secondary mb-3 text-base">{offering.requirements}</p>}
        <div className="flex flex-wrap items-baseline gap-2">
          <span className="text-base font-semibold">{library.label}</span>
          <TooltipButton
            onClick={() => void window.phosphor.invoke('app:openExternal', library.url)}
            className="text-accent cursor-pointer text-xs hover:underline"
          >
            {offering?.external ? 'Review upstream setup' : library.repo} ↗
          </TooltipButton>
          <span className="text-text-tertiary font-mono text-xs">@{library.sha.slice(0, 7)}</span>
        </div>
        <div className="text-text-tertiary pb-1.5 text-sm">{library.blurb}</div>
        {failure && (
          <div role="alert" className="text-danger pb-1 text-sm">
            {failure}
          </div>
        )}
        <div className="space-y-1">
          {visible.map((entry) => {
            const installed = installedNames.has(entry.name)
            return (
              <div
                key={entry.name}
                className="border-border flex items-start gap-2 rounded-lg border px-2.5 py-1.5"
              >
                <div className="min-w-0 flex-1">
                  <div className="truncate font-mono text-base font-medium">{entry.name}</div>
                  <div className="text-text-tertiary line-clamp-2 text-sm">{entry.description}</div>
                </div>
                <Button
                  size="sm"
                  aria-label={`${installed ? 'Installed' : 'Add'} ${entry.name}`}
                  variant={installed ? 'secondary' : 'primary'}
                  disabled={installed || busy != null}
                  onClick={() => void install(entry.name)}
                >
                  {installed ? 'Installed' : busy === entry.name ? 'Adding…' : 'Add'}
                </Button>
              </div>
            )
          })}
        </div>
      </details>
    </article>
  )
}

// ---------------------------------------------------------------------------
// Upload

function ImportSheet({
  preview,
  workspacePath,
  onClose,
  onImported,
}: {
  preview: SkillImportPreview
  workspacePath: string
  onClose: () => void
  onImported: () => void
}): React.JSX.Element {
  const [name, setName] = useState(preview.name ?? '')
  const [scope, setScope] = useState<SkillScope>('user')
  const [busy, setBusy] = useState(false)
  const [failure, setFailure] = useState<string | null>(null)

  const confirm = async (): Promise<void> => {
    setBusy(true)
    setFailure(null)
    try {
      await window.phosphor.invoke('skills:importConfirm', {
        sourcePath: preview.sourcePath,
        scope,
        workspacePath,
        ...(name !== preview.name ? { overrideName: name } : {}),
      })
      onImported()
    } catch (cause) {
      setFailure(cause instanceof Error ? cause.message : String(cause))
      setBusy(false)
    }
  }

  return (
    <ModalOverlay onClose={onClose}>
      <div className="border-border bg-surface w-[520px] max-w-[90vw] rounded-xl border p-5 shadow-lg">
        <div className="text-xl font-semibold">Upload skill</div>
        <div className="text-text-tertiary truncate pt-0.5 font-mono text-xs">
          {preview.sourcePath}
        </div>
        {preview.warnings.length > 0 && (
          <div className="text-warning pt-2 text-sm">
            {preview.warnings.map((warning) => (
              <div key={warning}>⚠ {warning}</div>
            ))}
          </div>
        )}
        <div className="pt-3">
          <div className="text-text-secondary pb-1 text-sm">Name</div>
          <TextInput size="sm" value={name} onChange={(event) => setName(event.target.value)} />
        </div>
        <div className="pt-2">
          <div className="text-text-secondary pb-1 text-sm">Install to</div>
          <Segmented
            value={scope}
            options={[
              { id: 'user', label: 'Global (all workspaces)' },
              { id: 'project', label: 'This project' },
            ]}
            onChange={setScope}
          />
        </div>
        <div className="border-border mt-3 max-h-40 overflow-y-auto rounded-lg border p-2">
          {preview.files.map((file) => (
            <div key={file.path} className="flex justify-between font-mono text-sm">
              <span className="truncate">{file.path}</span>
              <span className="text-text-tertiary shrink-0 pl-3">{formatSize(file.size)}</span>
            </div>
          ))}
        </div>
        {failure && <div className="text-danger pt-2 text-sm">{failure}</div>}
        <div className="flex justify-end gap-2 pt-4">
          <Button onClick={onClose}>Cancel</Button>
          <Button variant="primary" disabled={busy || !name} onClick={() => void confirm()}>
            {busy ? 'Installing…' : 'Install skill'}
          </Button>
        </div>
      </div>
    </ModalOverlay>
  )
}
