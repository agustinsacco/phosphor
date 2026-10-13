import { memo, useCallback, useId, useLayoutEffect, useMemo, useRef } from 'react'
import clsx from 'clsx'
import { MAX_TEXT_FILE_BYTES } from '@shared/file-kinds'
import {
  MAX_LISTED_FILES,
  MAX_SEARCH_RESULTS,
  SEARCH_TIME_LIMIT_MS,
  type FileSearchResult,
  type LineMatch,
  type WorkspaceSearchResult,
} from '@shared/workspace-search'
import {
  ChevronIcon,
  CloseIcon,
  CollapseAllIcon,
  MoreIcon,
  ReloadIcon,
  SearchIcon,
  Spinner,
} from '@/components/icons'
import { IconToggle } from '@/components/IconToggle'
import { optionForKey, SearchOptionToggles } from '@/components/search/SearchOptionToggles'
import { openFileInWorkspace } from '@/stores/layout'
import { splitPath } from '@/lib/path'
import { runFileAction } from './fileActions'
import { type SearchRow, useSearchResultsNav } from './useSearchResultsNav'
import { inputError, useWorkspaceSearchStore, workspaceSearch } from './workspaceSearchStore'

/** The focus request each workspace's panel last honoured, so a remount does not steal focus. */
const honouredFocus = new Map<string, number>()

const plural = (count: number, word: string): string =>
  `${count.toLocaleString()} ${word}${count === 1 ? '' : 's'}`

/** The largest file searched, as the note about skipped files puts it. */
const TEXT_FILE_LIMIT = `${+(MAX_TEXT_FILE_BYTES / 2 ** 20).toFixed(1)} MB`

/** A key pressed while an IME is composing belongs to the composition, not the panel. */
const composing = (event: React.KeyboardEvent): boolean =>
  event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229

type Field = 'query' | 'include' | 'exclude'

function openMatch(
  workspacePath: string,
  file: FileSearchResult,
  match: LineMatch,
  focus: boolean,
): void {
  runFileAction(
    openFileInWorkspace(workspacePath, file.path, {
      line: match.line,
      column: match.column,
      endLine: match.endLine,
      endColumn: match.endColumn,
      focus,
    }),
  )
}

/**
 * Search across the workspace's files, in the Files pane's left column (it
 * takes the explorer tree's place while open).
 *
 * The query box is the find bar's: same toggles, same ⌥C ⌥W ⌥R, same matching
 * rules (`shared/text-search.ts`). Main runs the search (`fs:searchWorkspace`);
 * each result is a file and a line, and choosing one opens the file with the
 * match selected.
 *
 * Keys: ↓ from the field enters the results; ↑ ↓ move, ← → fold and unfold,
 * Space opens the match and stays here, Enter opens it in the editor. A click
 * opens it and stays here too; a double-click goes to the editor. Escape goes
 * back to the field, and from the field back to the explorer.
 */
export const WorkspaceSearch = memo(function WorkspaceSearch({
  workspacePath,
}: {
  workspacePath: string
}): React.JSX.Element {
  const search = useWorkspaceSearchStore((s) => workspaceSearch(s, workspacePath))
  const actions = useWorkspaceSearchStore.getState()
  const inputRef = useRef<HTMLInputElement>(null)
  const statusId = useId()

  const { query, options, include, exclude, result, collapsed } = search
  // Checked field by field, so the one marked invalid is the one at fault.
  const invalid = useMemo<Record<Field, string | null>>(
    () => ({
      query: inputError({ query, options, include: '', exclude: '' }),
      include: inputError({ query: '', options, include, exclude: '' }),
      exclude: inputError({ query: '', options, include: '', exclude }),
    }),
    [query, options, include, exclude],
  )
  const inputProblem = invalid.query ?? invalid.include ?? invalid.exclude
  // The field the status line's error is about; a failed search is the query's.
  const faulty: Field | null = invalid.query
    ? 'query'
    : invalid.include
      ? 'include'
      : invalid.exclude
        ? 'exclude'
        : result?.error
          ? 'query'
          : null
  const fieldAria = (field: Field) => ({
    'aria-invalid': invalid[field] !== null,
    'aria-describedby': faulty === field ? statusId : undefined,
  })

  const focusField = useCallback(() => inputRef.current?.focus(), [])
  const onChoose = useCallback(
    (row: SearchRow, focus: boolean): void => {
      if (row.kind === 'file') {
        useWorkspaceSearchStore.getState().toggleCollapsed(workspacePath, row.file.path)
      } else openMatch(workspacePath, row.file, row.match, focus)
    },
    [workspacePath],
  )
  const onToggle = useCallback(
    (path: string) => useWorkspaceSearchStore.getState().toggleCollapsed(workspacePath, path),
    [workspacePath],
  )
  const nav = useSearchResultsNav({ result, collapsed, onChoose, onToggle, onExit: focusField })

  useLayoutEffect(() => {
    if (honouredFocus.get(workspacePath) === search.focusRequest) return
    honouredFocus.set(workspacePath, search.focusRequest)
    inputRef.current?.focus()
    inputRef.current?.select()
  }, [workspacePath, search.focusRequest])

  const onPanelKeyDown = (event: React.KeyboardEvent): void => {
    if (composing(event)) return
    const toggle = optionForKey(event)
    if (toggle) {
      event.preventDefault()
      actions.toggleOption(workspacePath, toggle)
    }
  }

  const onFieldKeyDown = (event: React.KeyboardEvent<HTMLInputElement>): void => {
    // Enter and Escape mid-composition confirm or drop the IME's candidate.
    if (composing(event)) return
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      actions.closeSearch(workspacePath)
    } else if (event.key === 'Enter') {
      // Search now rather than after the pause; the refresh for stale results.
      event.preventDefault()
      void actions.run(workspacePath)
    } else if (event.key === 'ArrowDown' && event.currentTarget === inputRef.current) {
      if (nav.enter()) event.preventDefault()
    }
  }

  const allCollapsed = !!result?.files.length && result.files.every((file) => collapsed[file.path])

  return (
    <div
      data-testid="workspace-search"
      role="search"
      onKeyDown={onPanelKeyDown}
      className="flex h-full min-w-0 flex-col"
    >
      <div className="border-border flex shrink-0 items-center justify-between gap-1 border-b px-2 py-1">
        <span className="text-text-tertiary text-xs font-semibold font-mono uppercase tracking-wider">
          Search
        </span>
        <div className="flex items-center gap-0.5">
          <IconToggle
            title="Files to include or exclude"
            expanded={search.showScope}
            onClick={() => actions.setShowScope(workspacePath, !search.showScope)}
          >
            <MoreIcon size={13} />
          </IconToggle>
          <IconToggle title="Search again" onClick={() => void actions.run(workspacePath)}>
            <ReloadIcon />
          </IconToggle>
          <IconToggle
            title={allCollapsed ? 'Expand all' : 'Collapse all'}
            onClick={() => actions.collapseAll(workspacePath, !allCollapsed)}
          >
            <CollapseAllIcon expand={allCollapsed} />
          </IconToggle>
          <IconToggle
            title="Back to the explorer (Esc)"
            onClick={() => actions.closeSearch(workspacePath)}
          >
            <CloseIcon size={11} strokeWidth={2.5} />
          </IconToggle>
        </div>
      </div>

      <div className="border-border flex shrink-0 flex-col gap-1 border-b p-2">
        <div className="border-border bg-surface focus-within:border-border-strong flex min-w-0 items-center gap-1 rounded-md border py-0.5 pl-1.5 pr-0.5">
          <SearchIcon size={11} className="text-text-tertiary shrink-0" />
          <input
            ref={inputRef}
            value={query}
            onChange={(event) => actions.setInputs(workspacePath, { query: event.target.value })}
            onKeyDown={onFieldKeyDown}
            placeholder="Search files"
            aria-label="Search files"
            {...fieldAria('query')}
            spellCheck={false}
            data-testid="workspace-search-input"
            className="find-field text-text placeholder:text-text-tertiary min-w-0 flex-1 bg-transparent py-0.5 text-sm outline-none"
            data-tooltip="Search files"
          />
          <SearchOptionToggles
            options={options}
            onToggle={(key) => actions.toggleOption(workspacePath, key)}
          />
        </div>
        {search.showScope && (
          <>
            <ScopeField
              label="Files to include"
              placeholder="e.g. src, *.ts, docs/**/*.md"
              value={include}
              aria={fieldAria('include')}
              onChange={(value) => actions.setInputs(workspacePath, { include: value })}
              onKeyDown={onFieldKeyDown}
            />
            <ScopeField
              label="Files to exclude"
              placeholder="e.g. *.test.ts, dist"
              value={exclude}
              aria={fieldAria('exclude')}
              onChange={(value) => actions.setInputs(workspacePath, { exclude: value })}
              onKeyDown={onFieldKeyDown}
            />
          </>
        )}
        <SearchSummary
          id={statusId}
          error={inputProblem ?? result?.error ?? null}
          query={query}
          result={result}
          searching={search.searching}
        />
      </div>

      <div
        {...nav.listProps}
        role="tree"
        aria-label="Search results"
        data-testid="workspace-search-results"
        className="min-h-0 flex-1 overflow-y-auto py-1 outline-none"
      >
        <ResultsTree
          rows={nav.rows}
          collapsed={collapsed}
          active={nav.active}
          rowId={nav.rowId}
          onChoose={nav.choose}
        />
      </div>
    </div>
  )
})

function ScopeField({
  label,
  placeholder,
  value,
  aria,
  onChange,
  onKeyDown,
}: {
  label: string
  placeholder: string
  value: string
  aria: { 'aria-invalid': boolean; 'aria-describedby': string | undefined }
  onChange: (value: string) => void
  onKeyDown: (event: React.KeyboardEvent<HTMLInputElement>) => void
}): React.JSX.Element {
  return (
    <label className="flex flex-col gap-0.5">
      <span className="text-text-tertiary text-2xs">{label}</span>
      <input
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        placeholder={placeholder}
        {...aria}
        spellCheck={false}
        className="find-field border-border bg-surface text-text placeholder:text-text-tertiary focus:border-border-strong rounded-md border px-1.5 py-0.5 text-sm outline-none"
      />
    </label>
  )
}

/**
 * "12 results in 3 files", and why a search stopped short or passed files
 * over; or what is wrong with the inputs. One element throughout, so a screen
 * reader hears each change and the fields can point at it.
 */
function SearchSummary({
  id,
  error,
  query,
  result,
  searching,
}: {
  id: string
  error: string | null
  query: string
  result: WorkspaceSearchResult | null
  searching: boolean
}): React.JSX.Element {
  const notes: string[] = []
  if (result?.stopped === 'results') {
    notes.push(`Stopped at ${plural(MAX_SEARCH_RESULTS, 'result')} — narrow the search.`)
  }
  if (result?.stopped === 'time') {
    notes.push(
      `Stopped after ${SEARCH_TIME_LIMIT_MS / 1000} seconds — these are the results so far.`,
    )
  }
  if (result?.stopped === 'cancelled') notes.push('Stopped early — press Enter to search again.')
  if (result?.moreFiles) {
    notes.push(`Only the first ${plural(MAX_LISTED_FILES, 'file')} were searched.`)
  }
  if (result?.skippedFiles) {
    notes.push(
      `${plural(result.skippedFiles, 'file')} skipped: binary, media or over ${TEXT_FILE_LIMIT}.`,
    )
  }
  return (
    <div
      id={id}
      role="status"
      className={clsx(
        'flex flex-col gap-0.5 text-2xs empty:hidden',
        error ? 'text-danger' : 'text-text-tertiary',
      )}
      data-testid="workspace-search-status"
    >
      {error ? (
        error
      ) : query === '' ? null : (
        <>
          <div className="flex items-center gap-1.5">
            {searching && <Spinner className="text-text-tertiary" />}
            <span className="tabular-nums">
              {!result
                ? 'Searching…'
                : result.matchCount === 0
                  ? 'No results'
                  : `${plural(result.matchCount, 'result')} in ${plural(result.files.length, 'file')}`}
            </span>
          </div>
          {notes.map((note) => (
            <div key={note}>{note}</div>
          ))}
        </>
      )}
    </div>
  )
}

/**
 * The rows, apart from the panel so typing in its fields leaves them be, and
 * each row apart from the rest so moving the cursor redraws two of them.
 */
const ResultsTree = memo(function ResultsTree({
  rows,
  collapsed,
  active,
  rowId,
  onChoose,
}: {
  rows: SearchRow[]
  collapsed: Record<string, true>
  active: number
  rowId: (index: number) => string
  onChoose: (row: SearchRow, focus: boolean) => void
}): React.JSX.Element {
  return (
    <>
      {rows.map((row, index) =>
        row.kind === 'file' ? (
          <FileRow
            key={row.key}
            id={rowId(index)}
            row={row}
            expanded={!collapsed[row.file.path]}
            active={index === active}
            onChoose={onChoose}
          />
        ) : (
          <MatchRow
            key={row.key}
            id={rowId(index)}
            row={row}
            active={index === active}
            onChoose={onChoose}
          />
        ),
      )}
    </>
  )
})

const FileRow = memo(function FileRow({
  id,
  row,
  expanded,
  active,
  onChoose,
}: {
  id: string
  row: Extract<SearchRow, { kind: 'file' }>
  expanded: boolean
  active: boolean
  onChoose: (row: SearchRow, focus: boolean) => void
}): React.JSX.Element {
  const { file } = row
  const { dir, base } = splitPath(file.path)
  return (
    <div
      id={id}
      role="treeitem"
      aria-level={1}
      aria-expanded={expanded}
      aria-selected={active}
      aria-label={`${file.path}, ${plural(file.matches.length, 'result')}`}
      data-tooltip={file.path}
      data-search-file={file.path}
      onClick={() => onChoose(row, false)}
      className={clsx(
        'flex cursor-pointer items-center gap-1.5 py-[3px] pl-2.5 pr-2 text-base transition-colors',
        active
          ? 'bg-accent-soft text-text'
          : 'text-text-secondary hover:bg-bg-secondary/60 hover:text-text',
      )}
    >
      <ChevronIcon size={9} strokeWidth={3} expanded={expanded} className="text-text-tertiary" />
      <span className="text-text min-w-0 truncate">{base}</span>
      {dir && <span className="text-text-tertiary min-w-0 flex-1 truncate text-sm">{dir}</span>}
      {!dir && <span className="flex-1" />}
      <span className="bg-bg-secondary text-text-tertiary shrink-0 rounded-full px-1.5 text-2xs tabular-nums">
        {file.matches.length}
      </span>
    </div>
  )
})

const MatchRow = memo(function MatchRow({
  id,
  row,
  active,
  onChoose,
}: {
  id: string
  row: Extract<SearchRow, { kind: 'match' }>
  active: boolean
  onChoose: (row: SearchRow, focus: boolean) => void
}): React.JSX.Element {
  const { match } = row
  const { preview, previewStart, previewEnd } = match
  // Indentation says nothing in a list of lines; drop it, but never into the match.
  const indent = Math.min(preview.length - preview.trimStart().length, previewStart)
  return (
    <div
      id={id}
      role="treeitem"
      aria-level={2}
      aria-selected={active}
      aria-label={`Line ${match.line}: ${preview.trim()}`}
      data-tooltip={`Line ${match.line}, column ${match.column} · double-click to edit`}
      data-search-line={match.line}
      onClick={() => onChoose(row, false)}
      onDoubleClick={() => onChoose(row, true)}
      className={clsx(
        'flex cursor-pointer items-baseline gap-2 py-[2px] pl-8 pr-2 font-mono text-sm transition-colors',
        active
          ? 'bg-accent-soft text-text'
          : 'text-text-secondary hover:bg-bg-secondary/60 hover:text-text',
      )}
    >
      {/* In a narrow pane the text after the match gives way first (it only fills
          the space left over), then the text before it from its left edge; the
          match stays in view. The trailing LRM keeps a space before the match
          from moving to the start of the line, where bidi puts trailing
          whitespace in a right-to-left box. */}
      <span className="flex min-w-0 flex-1 whitespace-pre">
        <span dir="rtl" className="min-w-0 overflow-hidden text-ellipsis">
          <bdi dir="ltr">{preview.slice(indent, previewStart) + '\u200e'}</bdi>
        </span>
        <mark className="search-hit max-w-full shrink-0 overflow-hidden text-ellipsis">
          {preview.slice(previewStart, previewEnd)}
        </mark>
        <span className="min-w-0 flex-1 overflow-hidden text-ellipsis">
          {preview.slice(previewEnd)}
        </span>
      </span>
      <span className="text-text-tertiary shrink-0 text-2xs tabular-nums">{match.line}</span>
    </div>
  )
})
