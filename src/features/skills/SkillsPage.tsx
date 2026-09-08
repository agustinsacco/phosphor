import { memo, useEffect, useMemo, useState } from 'react'
import clsx from 'clsx'
import type { ResolvedSkill, SkillImportPreview, SkillScope } from '@shared/skills'
import { parseSkillFrontmatter, setSkillDraftFlag } from '@shared/skills'
import { SKILL_CATALOG, type SkillCatalogLibrary } from '@shared/skillsCatalog'
import { useSkillsStore } from '@/stores/skills'
import { PageShell } from '@/components/PageShell'
import { PaneTitle } from '@/components/PaneShell'
import { ModalOverlay } from '@/components/Modal'
import { Button, TextInput } from '@/components/form'
import { Markdown } from '@/components/markdown/Markdown'
import { NewSkillModal } from './NewSkillModal'

/**
 * Global Skills page (sidebar → Skills), modeled on Claude Desktop's
 * Customize → Skills: a **Yours** tab listing everything pi resolves, grouped
 * by where it lives, and a **Discover** tab of pinned curated libraries with
 * one-click install into the global root. Everything shown comes from
 * `skills:list`; every mutation round-trips through main and refreshes.
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
  const result = useSkillsStore((s) => s.byWorkspace[workspacePath])
  const loading = useSkillsStore((s) => s.loading[workspacePath] ?? false)
  const error = useSkillsStore((s) => s.error[workspacePath])
  const tab = useSkillsStore((s) => s.tab)
  const selectedDir = useSkillsStore((s) => s.selectedDir)
  const [search, setSearch] = useState('')
  const [creating, setCreating] = useState(false)
  const [importPreview, setImportPreview] = useState<SkillImportPreview | null>(null)

  useEffect(() => {
    void useSkillsStore.getState().refresh(workspacePath)
  }, [workspacePath])

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
          <Button size="sm" onClick={() => void pickImport()}>
            Upload
          </Button>
          <Button size="sm" variant="primary" onClick={() => setCreating(true)}>
            New skill
          </Button>
        </div>
      }
    >
      {/* Centered column: a page spans the whole main region, and list rows
          stretched across an ultrawide window stop reading as rows. */}
      <div className="mx-auto flex h-full min-h-0 w-full max-w-3xl flex-col">
        {selected ? (
          <SkillDetail
            skill={selected}
            workspacePath={workspacePath}
            onBack={() => useSkillsStore.getState().select(null)}
          />
        ) : (
          <>
            <div className="flex items-center gap-2 px-3 pb-2">
              <Segmented
                value={tab}
                options={[
                  { id: 'discover', label: 'Discover' },
                  { id: 'yours', label: `Yours${result ? ` · ${skills.length}` : ''}` },
                ]}
                onChange={(next) => useSkillsStore.getState().setTab(next)}
              />
              <TextInput
                size="sm"
                value={search}
                onChange={(event) => setSearch(event.target.value)}
                placeholder="Search skills"
                className="min-w-0 flex-1"
              />
            </div>
            <div className="min-h-0 flex-1 overflow-y-auto px-3 pb-3">
              {tab === 'yours' ? (
                <YoursList
                  skills={skills}
                  search={search}
                  loading={loading}
                  error={error}
                  probe={result?.probe}
                />
              ) : (
                <DiscoverList skills={skills} search={search} workspacePath={workspacePath} />
              )}
            </div>
          </>
        )}
      </div>
      {creating && (
        <NewSkillModal
          workspacePath={workspacePath}
          onClose={() => setCreating(false)}
          onCreated={() => {
            setCreating(false)
            void useSkillsStore.getState().refresh(workspacePath)
          }}
        />
      )}
      {importPreview && (
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
        <button
          key={option.id}
          onClick={() => onChange(option.id)}
          className={clsx(
            'cursor-pointer px-2.5 py-1 text-base transition-colors',
            option.id === value
              ? 'bg-bg-secondary text-text font-medium'
              : 'text-text-secondary hover:text-text',
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}

// ---------------------------------------------------------------------------
// Yours

/**
 * A human root label per skill, derived from its directory. Grouping by root
 * (not just scope) is the honesty the page exists for: `~/.claude/skills` and
 * `~/.pi/agent/skills` are both "user" to pi, and telling them apart is how
 * the user knows what a borrowed skill is.
 */
function rootLabel(skill: ResolvedSkill): string {
  if (skill.origin === 'package') return 'Packages (read-only)'
  const scope = skill.scope === 'project' ? 'Project' : 'Global'
  if (skill.borrowed) return `${scope} · .claude/skills (borrowed)`
  if (!skill.writable && skill.scope === 'user') return `Global · other`
  return skill.scope === 'project' ? 'Project · .pi/skills' : 'Global · ~/.pi/agent/skills'
}

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
  const groups = new Map<string, ResolvedSkill[]>()
  for (const skill of visible) {
    const label = rootLabel(skill)
    groups.set(label, [...(groups.get(label) ?? []), skill])
  }
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
      {[...groups.entries()].map(([label, group]) => (
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
    <button
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
    </button>
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
  const [failure, setFailure] = useState<string | null>(null)

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
  }, [skill.dir, file])

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

  const remove = (): Promise<void> =>
    run('delete', async () => {
      await window.phosphor.invoke('skills:delete', skill.dir, workspacePath)
      onBack()
    })

  const body = useMemo(
    () => (content != null ? parseSkillFrontmatter(content).body : null),
    [content],
  )

  return (
    <div className="flex h-full min-h-0 flex-col px-3 pb-3">
      <div className="flex items-center gap-2 pb-1">
        <button
          onClick={onBack}
          className="text-text-secondary hover:text-text cursor-pointer text-base"
        >
          ← Skills
        </button>
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <span className="font-mono text-lg font-semibold">{skill.name}</span>
        <Tag tone="neutral">{skill.scope}</Tag>
        {skill.borrowed && <Tag tone="neutral">claude code</Tag>}
        {skill.origin === 'package' && <Tag tone="neutral">{skill.source}</Tag>}
        {skill.draft && <Tag tone="amber">draft</Tag>}
      </div>
      <div className="text-text-tertiary truncate pt-0.5 font-mono text-xs" title={skill.dir}>
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
          <button
            key={id}
            onClick={() => setView(id)}
            className={clsx(
              'cursor-pointer rounded-md px-2 py-0.5 text-base capitalize',
              view === id ? 'bg-bg-secondary text-text font-medium' : 'text-text-secondary',
            )}
          >
            {id}
          </button>
        ))}
        <span className="flex-1" />
        {skill.writable && (
          <Button size="sm" disabled={pending != null} onClick={() => void toggleDraft()}>
            {skill.draft ? 'Publish' : 'Hide from model'}
          </Button>
        )}
        {updateAvailable(skill) && (
          <Button
            size="sm"
            variant="primary"
            disabled={pending != null}
            onClick={() => void update()}
          >
            Update
          </Button>
        )}
        <Button
          size="sm"
          disabled={pending != null}
          onClick={() =>
            void run('export', () => window.phosphor.invoke('skills:export', skill.dir))
          }
        >
          Export
        </Button>
        {skill.writable && (
          <Button
            size="sm"
            variant="danger"
            disabled={pending != null}
            onClick={() => void remove()}
          >
            Delete
          </Button>
        )}
      </div>
      {failure && <div className="text-danger pb-1 text-sm">{failure}</div>}
      <div className="border-border min-h-0 flex-1 overflow-y-auto rounded-lg border p-3">
        {view === 'files' ? (
          <div className="space-y-0.5">
            {skill.files.map((entry) => (
              <button
                key={entry.path}
                onClick={() => {
                  setFile(entry.path)
                  setView('source')
                }}
                className="hover:bg-bg-secondary flex w-full cursor-pointer justify-between rounded px-1.5 py-0.5 text-left font-mono text-sm"
              >
                <span className="truncate">{entry.path}</span>
                <span className="text-text-tertiary shrink-0 pl-3">{formatSize(entry.size)}</span>
              </button>
            ))}
          </div>
        ) : content == null ? (
          <div className="text-text-tertiary text-sm">
            {file}: not a text file, or still loading.
          </div>
        ) : view === 'preview' ? (
          <Markdown text={body ?? content} />
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
  return (
    <div className="space-y-4">
      <div className="text-text-tertiary text-sm">
        Curated libraries, pinned by commit — installs land in the global pi root and follow you
        into every workspace and provider. Skills can instruct the model and ship scripts it may
        run; read one before adding it.
      </div>
      {SKILL_CATALOG.map((library) => (
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
  const needle = search.trim().toLowerCase()
  const visible = library.skills.filter(
    (entry) =>
      !needle ||
      entry.name.toLowerCase().includes(needle) ||
      entry.description.toLowerCase().includes(needle),
  )
  if (visible.length === 0) return null

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
    <div>
      <div className="flex items-baseline gap-2">
        <span className="text-base font-semibold">{library.label}</span>
        <button
          onClick={() => void window.phosphor.invoke('app:openExternal', library.url)}
          className="text-accent cursor-pointer text-xs hover:underline"
        >
          {library.repo} ↗
        </button>
        <span className="text-text-tertiary font-mono text-xs">@{library.sha.slice(0, 7)}</span>
      </div>
      <div className="text-text-tertiary pb-1.5 text-sm">{library.blurb}</div>
      {failure && <div className="text-danger pb-1 text-sm">{failure}</div>}
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
    </div>
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
