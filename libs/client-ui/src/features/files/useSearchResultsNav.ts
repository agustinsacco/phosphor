import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState } from 'react'
import type { FileSearchResult, LineMatch, WorkspaceSearchResult } from '@shared/workspace-search'

/** One line of the results tree: a file, or one of its matches. */
export type SearchRow =
  | { kind: 'file'; key: string; file: FileSearchResult }
  | { kind: 'match'; key: string; file: FileSearchResult; match: LineMatch }

/** The result tree as the rows on screen: each file, then its matches unless folded. */
export function visibleRows(
  result: WorkspaceSearchResult | null,
  collapsed: Record<string, true>,
): SearchRow[] {
  const rows: SearchRow[] = []
  for (const file of result?.files ?? []) {
    rows.push({ kind: 'file', key: `f:${file.path}`, file })
    if (collapsed[file.path]) continue
    for (const match of file.matches) {
      rows.push({ kind: 'match', key: `m:${file.path}:${match.line}:${match.column}`, file, match })
    }
  }
  return rows
}

/**
 * The row the cursor is on, held by what it is rather than where it is:
 * folding a file above it moves the row, and the cursor goes with it. It
 * belongs to one answer; a new one starts the cursor over.
 */
interface Cursor {
  result: WorkspaceSearchResult | null
  key: string
  /** The row's file, where the cursor lands when its match is folded away. */
  file: string
}

/**
 * The keyboard for a results tree: one focusable list that points at its
 * active row (`aria-activedescendant`), so ↑ ↓ never move DOM focus and the
 * query field stays one ↑ away.
 */
export function useSearchResultsNav({
  result,
  collapsed,
  onChoose,
  onToggle,
  onExit,
}: {
  result: WorkspaceSearchResult | null
  collapsed: Record<string, true>
  /** Act on a row: fold or unfold a file, open a match (`focus`: in the editor). */
  onChoose: (row: SearchRow, focus: boolean) => void
  /** Fold or unfold a file's matches. */
  onToggle: (path: string) => void
  /** Leave the list, up past its first row or with Escape. */
  onExit: () => void
}) {
  const listRef = useRef<HTMLDivElement>(null)
  const idPrefix = useId()
  const rows = useMemo(() => visibleRows(result, collapsed), [result, collapsed])
  const [cursorState, setCursorState] = useState<Cursor | null>(null)
  const cursor = cursorState && cursorState.result === result ? cursorState : null

  let active = -1
  if (cursor) {
    active = rows.findIndex((row) => row.key === cursor.key)
    if (active < 0) {
      active = rows.findIndex((row) => row.kind === 'file' && row.file.path === cursor.file)
    }
  }

  const rowId = useCallback((index: number): string => `${idPrefix}-row-${index}`, [idPrefix])

  const put = useCallback(
    (row: SearchRow | undefined): void => {
      if (row) setCursorState({ result, key: row.key, file: row.file.path })
    },
    [result],
  )

  const choose = useCallback(
    (row: SearchRow, focus: boolean): void => {
      put(row)
      onChoose(row, focus)
    },
    [put, onChoose],
  )

  // A new answer is read from the top.
  useLayoutEffect(() => {
    if (listRef.current) listRef.current.scrollTop = 0
  }, [result])

  useEffect(() => {
    if (active >= 0) document.getElementById(rowId(active))?.scrollIntoView({ block: 'nearest' })
  }, [active, rowId])

  /** ↓ from the query field: into the list, at its cursor or else the first row. */
  const enter = (): boolean => {
    if (rows.length === 0) return false
    if (active < 0) put(rows[0])
    listRef.current?.focus()
    return true
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLDivElement>): void => {
    const row = rows[active]
    const move = (index: number): void => {
      event.preventDefault()
      put(rows[Math.min(Math.max(index, 0), rows.length - 1)])
    }
    switch (event.key) {
      case 'ArrowDown':
        return move(active + 1)
      case 'ArrowUp':
        if (active > 0) return move(active - 1)
        event.preventDefault()
        return onExit()
      case 'Home':
        return move(0)
      case 'End':
        return move(rows.length - 1)
      case 'ArrowRight':
        if (row?.kind !== 'file') return
        event.preventDefault()
        if (collapsed[row.file.path]) onToggle(row.file.path)
        else put(rows[active + 1])
        return
      case 'ArrowLeft':
        if (!row) return
        event.preventDefault()
        if (row.kind === 'match') put(rows.find((r) => r.kind === 'file' && r.file === row.file))
        else if (!collapsed[row.file.path]) onToggle(row.file.path)
        return
      case 'Enter':
      case ' ':
        if (!row) return
        event.preventDefault()
        return choose(row, event.key === 'Enter')
      case 'Escape':
        event.preventDefault()
        event.stopPropagation()
        return onExit()
    }
  }

  const onFocus = (event: React.FocusEvent<HTMLDivElement>): void => {
    if (event.target !== event.currentTarget || cursor || rows.length === 0) return
    // Tabbing in puts the cursor on the first row, for ↑ ↓ and Enter to start
    // from. A click leaves it to the click: moving it here would scroll the
    // list under the pointer between press and release, and the click is lost.
    if (event.currentTarget.matches(':focus-visible')) put(rows[0])
  }

  return {
    rows,
    /** Index of the cursor's row in `rows`; -1 until it is placed. */
    active,
    rowId,
    /** A row clicked or confirmed: the cursor moves there, then `onChoose`. */
    choose,
    enter,
    listProps: {
      ref: listRef,
      tabIndex: rows.length > 0 ? 0 : -1,
      'aria-activedescendant': active >= 0 ? rowId(active) : undefined,
      onKeyDown,
      onFocus,
    },
  }
}
