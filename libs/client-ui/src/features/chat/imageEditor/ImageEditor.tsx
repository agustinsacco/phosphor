import { TooltipLabel } from '@/components/Tooltip'
import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react'
import { ipcErrorText } from '@shared/errors'
import { ModalOverlay } from '@/components/Modal'
import { Button } from '@/components/form'
import { bytesToBase64 } from '@/lib/base64'
import { formatShortcut } from '@/lib/shortcuts'
import { useExtensionUiStore } from '@/stores/extensionUi'
import { annotatedName, type PendingImage } from '../attachments'
import { COLORS, EditorToolbar, SIZES, TOOLS, type Size, type Tool } from './EditorToolbar'
import {
  HANDLE_RADIUS,
  contrastFor,
  decodeImage,
  drawScene,
  drawSelection,
  flattenScene,
  measureWith,
  textFont,
} from './render'
import {
  TEXT_LINE_HEIGHT,
  addShape,
  commit,
  dragHandle,
  handles,
  hitTest,
  initHistory,
  isDegenerate,
  newId,
  nextStep,
  normalizeBox,
  placeLayer,
  redo,
  translate,
  undo,
  withShape,
  type Handle,
  type History,
  type LayerImage,
  type Pt,
  type Scene,
  type Shape,
  type TextShape,
} from './scene'

/**
 * Annotate a pending composer image: draw boxes, circles, arrows, text and
 * numbered markers on it, paste another image on top, or swap the screenshot
 * underneath. Done flattens everything to one PNG, which is what pi receives;
 * the annotations are pixels in the image, never text in the prompt.
 *
 * "Replace original" (on by default) swaps the chip in place. Off, the
 * annotated copy is attached next to the original and the user removes
 * whichever they do not want.
 */

type Gesture =
  | { type: 'draw'; start: Pt; shape: Shape }
  | { type: 'move'; start: Pt; origin: Shape }
  | { type: 'handle'; handle: Handle; origin: Shape }

interface TextEdit {
  shape: TextShape
  isNew: boolean
}

/** How far a pasted image may be magnified to fill the stage. */
const MAX_ZOOM = 4

function toast(message: string, kind: 'info' | 'error' = 'info'): void {
  useExtensionUiStore.getState().pushToast(message, kind)
}

export function ImageEditor({
  image,
  onCancel,
  onSave,
}: {
  image: PendingImage
  onCancel: () => void
  /** False when the composer refused it (too many bytes): the editor stays open. */
  onSave: (image: PendingImage, replace: boolean) => boolean
}): React.JSX.Element {
  const [history, setHistory] = useState<History | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [tool, setToolState] = useState<Tool>('rect')
  const [color, setColor] = useState(COLORS[0]!)
  const [size, setSize] = useState<Size>('M')
  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [textEdit, setTextEditState] = useState<TextEdit | null>(null)
  const [replace, setReplace] = useState(true)
  const [discardArmed, setDiscardArmed] = useState(false)
  const [saving, setSaving] = useState(false)
  const [stage, setStage] = useState({ w: 0, h: 0 })
  /** Bumped as images finish decoding, so the canvas repaints with them. */
  const [decodedCount, setDecodedCount] = useState(0)

  // Mirrors of in-flight state, read by handlers that can run before React
  // re-renders (a pointerup right after the last pointermove, a blur that
  // races a click).
  const liveRef = useRef<Scene | null>(null)
  const [live, setLiveState] = useState<Scene | null>(null)
  const textEditRef = useRef<TextEdit | null>(null)
  const gesture = useRef<Gesture | null>(null)

  const rootRef = useRef<HTMLDivElement>(null)
  const stageRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const decodedImages = useRef(new Map<string, HTMLImageElement>())
  const lookup = useCallback((img: LayerImage) => decodedImages.current.get(img.id), [])
  const measure = useMemo(() => {
    const ctx = document.createElement('canvas').getContext('2d')
    return ctx ? measureWith(ctx) : () => ({ w: 0, h: 0 })
  }, [])

  const setLive = (scene: Scene | null): void => {
    liveRef.current = scene
    setLiveState(scene)
  }
  const setTextEdit = (edit: TextEdit | null): void => {
    textEditRef.current = edit
    setTextEditState(edit)
  }

  const load = useCallback(async (data: string, mimeType: string, id = newId()) => {
    const decoded = await decodeImage(data, mimeType)
    decodedImages.current.set(id, decoded.element)
    setDecodedCount((n) => n + 1)
    return { id, data, mimeType, width: decoded.width, height: decoded.height }
  }, [])

  // Decode once, from the image the editor was opened on: the drafts store
  // swaps the attachment for a copy carrying its blobId, and that must not
  // reset the editor. Reopening an annotated image restores its layers rather
  // than drawing on the flat PNG.
  const opened = useRef(image).current
  useEffect(() => {
    let cancelled = false
    void (async () => {
      try {
        const previous = opened.annotation
        let scene: Scene
        if (previous) {
          const layers = [
            previous.base,
            ...previous.shapes.flatMap((s) => (s.kind === 'image' ? [s.image] : [])),
          ]
          await Promise.all(layers.map((l) => load(l.data, l.mimeType, l.id)))
          scene = previous
        } else {
          scene = { base: await load(opened.data, opened.mimeType), shapes: [] }
        }
        if (!cancelled) setHistory(initHistory(scene))
      } catch (error) {
        if (!cancelled) setLoadError(`This image could not be opened: ${ipcErrorText(error)}`)
      }
    })()
    return () => {
      cancelled = true
    }
  }, [opened, load])

  useEffect(() => rootRef.current?.focus(), [])

  useLayoutEffect(() => {
    const el = stageRef.current
    if (!el) return
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setStage({ w: entry.contentRect.width, h: entry.contentRect.height })
    })
    observer.observe(el)
    return () => observer.disconnect()
  }, [])

  const present = history?.present ?? null
  const presentRef = useRef(present)
  presentRef.current = present
  const scene = live ?? present
  const zoom =
    scene && stage.w > 0
      ? Math.min(stage.w / scene.base.width, stage.h / scene.base.height, MAX_ZOOM)
      : 0
  /** Image pixels per screen pixel: what a "5px" line costs in the PNG. */
  const unit = zoom > 0 ? 1 / zoom : 1
  const selected = present?.shapes.find((s) => s.id === selectedId) ?? null

  const hiddenId = textEdit && !textEdit.isNew ? textEdit.shape.id : undefined
  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d')
    if (!ctx || !scene) return
    drawScene(ctx, scene, lookup, hiddenId)
    const shown = scene.shapes.find((s) => s.id === selectedId)
    if (shown && tool === 'select') drawSelection(ctx, shown, unit, measure)
  }, [scene, hiddenId, selectedId, tool, unit, lookup, measure, decodedCount, zoom])

  const apply = (next: Scene): void => setHistory((h) => (h ? commit(h, next) : h))
  const stepHistory = (move: (h: History) => History): void => {
    setHistory((h) => h && move(h))
    setSelectedId(null)
  }
  /** Topmost shape under an image point, with a few screen pixels of slack. */
  const shapeAt = (p: Pt): Shape | null =>
    present ? hitTest(present.shapes, p, 6 * unit, measure) : null

  const setTool = (next: Tool): void => {
    if (next !== 'select') setSelectedId(null)
    setToolState(next)
  }

  /** Commit the text being typed; returns the scene it produced. */
  const finishText = (): Scene | null => {
    const edit = textEditRef.current
    if (!edit || !present) return null
    setTextEdit(null)
    // The textarea is about to unmount. If it still has focus, hand focus to
    // the editor NOW: left to fall to <body>, every shortcut typed before the
    // next frame (T, then a click, then N…) went nowhere or into stray text.
    if (document.activeElement?.tagName === 'TEXTAREA') rootRef.current?.focus()
    const text = edit.shape.text.replace(/\s+$/, '')
    const original = present.shapes.find((s) => s.id === edit.shape.id)
    let next = present
    if (!text) {
      if (original) next = withShape(present, original.id, null)
    } else if (original) {
      next = withShape(present, original.id, { ...edit.shape, text })
    } else {
      next = addShape(present, { ...edit.shape, text })
    }
    if (next !== present) apply(next)
    return next
  }

  const startText = (shape: TextShape, isNew: boolean): void => {
    setSelectedId(null)
    setTextEdit({ shape, isNew })
  }

  const toImagePoint = (event: React.PointerEvent | React.MouseEvent): Pt => {
    const rect = canvasRef.current!.getBoundingClientRect()
    const scale = present ? present.base.width / rect.width : 1
    return { x: (event.clientX - rect.left) * scale, y: (event.clientY - rect.top) * scale }
  }

  const onPointerDown = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    if (!present || event.button !== 0) return
    setDiscardArmed(false)
    if (textEditRef.current) {
      finishText()
      return
    }
    const p = toImagePoint(event)
    if (tool === 'text') {
      const hit = shapeAt(p)
      if (hit?.kind === 'text') startText(hit, false)
      else {
        const shape: TextShape = {
          kind: 'text',
          id: newId(),
          color,
          at: p,
          text: '',
          size: SIZES[size].text * unit,
        }
        startText(shape, true)
      }
      return
    }
    if (tool === 'step') {
      const n = nextStep(present.shapes)
      apply(
        addShape(present, {
          kind: 'step',
          id: newId(),
          color,
          at: p,
          n,
          size: SIZES[size].step * unit,
        }),
      )
      return
    }
    event.currentTarget.setPointerCapture(event.pointerId)
    if (tool === 'select') {
      const grip =
        selected &&
        handles(selected).find(
          (h) => Math.hypot(h.at.x - p.x, h.at.y - p.y) <= (HANDLE_RADIUS + 4) * unit,
        )
      if (selected && grip) {
        gesture.current = { type: 'handle', handle: grip.handle, origin: selected }
        return
      }
      const hit = shapeAt(p)
      setSelectedId(hit?.id ?? null)
      if (hit) gesture.current = { type: 'move', start: p, origin: hit }
      return
    }
    const id = newId()
    const width = SIZES[size].stroke * unit
    const shape: Shape =
      tool === 'pen' || tool === 'highlight'
        ? {
            kind: 'pen',
            id,
            color,
            width: tool === 'highlight' ? width * 4 : width,
            points: [p],
            highlight: tool === 'highlight',
          }
        : tool === 'arrow'
          ? { kind: 'arrow', id, color, width, from: p, to: p }
          : { kind: tool, id, color, width, x: p.x, y: p.y, w: 0, h: 0 }
    gesture.current = { type: 'draw', start: p, shape }
    setLive(addShape(present, shape))
  }

  const onPointerMove = (event: React.PointerEvent<HTMLCanvasElement>): void => {
    const g = gesture.current
    if (!g || !present) return
    const p = toImagePoint(event)
    if (g.type === 'move') {
      const moved = translate(g.origin, p.x - g.start.x, p.y - g.start.y)
      setLive(withShape(present, moved.id, moved))
      return
    }
    if (g.type === 'handle') {
      setLive(withShape(present, g.origin.id, dragHandle(g.origin, g.handle, p)))
      return
    }
    const s = g.shape
    let next: Shape
    if (s.kind === 'pen') {
      const last = s.points.at(-1)!
      if (Math.hypot(p.x - last.x, p.y - last.y) < 1.5 * unit) return
      next = { ...s, points: [...s.points, p] }
    } else if (s.kind === 'arrow') {
      next = { ...s, to: p }
    } else if (s.kind === 'rect' || s.kind === 'ellipse') {
      next = { ...s, ...normalizeBox(g.start, p, event.shiftKey) }
    } else {
      return
    }
    g.shape = next
    setLive(addShape(present, next))
  }

  const onPointerUp = (): void => {
    const g = gesture.current
    const result = liveRef.current
    gesture.current = null
    setLive(null)
    if (!g || !result) return
    if (g.type === 'draw' && isDegenerate(g.shape, 4 * unit)) return
    apply(result)
  }

  const onDoubleClick = (event: React.MouseEvent<HTMLCanvasElement>): void => {
    if (tool !== 'select') return
    const hit = shapeAt(toImagePoint(event))
    if (hit?.kind === 'text') startText(hit, false)
  }

  const recolor = (next: string): void => {
    setColor(next)
    const edit = textEditRef.current
    if (edit) {
      setTextEdit({ ...edit, shape: { ...edit.shape, color: next } })
    } else if (present && selected && selected.kind !== 'image' && tool === 'select') {
      apply(withShape(present, selected.id, { ...selected, color: next }))
    }
  }

  const resize = (next: Size): void => {
    setSize(next)
    const edit = textEditRef.current
    if (edit) setTextEdit({ ...edit, shape: { ...edit.shape, size: SIZES[next].text * unit } })
  }

  const deleteSelected = (): void => {
    if (!present || !selected) return
    apply(withShape(present, selected.id, null))
    setSelectedId(null)
  }

  /** Put a new image on top, or swap the base. Decoding first sizes it. */
  const addImage = async (
    data: string,
    mimeType: string,
    mode: 'layer' | 'replace',
  ): Promise<void> => {
    try {
      const layer = await load(data, mimeType)
      // Read after the await: the user may have drawn while it decoded.
      const current = presentRef.current
      if (!current) return
      if (mode === 'replace') {
        apply({ ...current, base: layer })
        return
      }
      const shape = placeLayer(layer, current.base)
      apply(addShape(current, shape))
      setToolState('select')
      setSelectedId(shape.id)
    } catch (error) {
      toast(`That image could not be read: ${ipcErrorText(error)}`, 'error')
    }
  }

  const fromClipboard = async (mode: 'layer' | 'replace'): Promise<void> => {
    try {
      const clip = await window.phosphor.invoke('clipboard:readImage')
      if (!clip) toast('The clipboard has no image to paste.')
      else await addImage(clip.data, clip.mimeType, mode)
    } catch (error) {
      toast(`Could not read the clipboard: ${ipcErrorText(error)}`, 'error')
    }
  }

  const fromFiles = (files: File[]): boolean => {
    const file = files.find((f) => f.type.startsWith('image/'))
    if (!file) return false
    void file.arrayBuffer().then((bytes) => addImage(bytesToBase64(bytes), file.type, 'layer'))
    return true
  }

  const done = async (): Promise<void> => {
    if (!history || saving) return
    const final = finishText() ?? history.present
    if (history.past.length === 0 && final === history.present) {
      onCancel()
      return
    }
    setSaving(true)
    try {
      const data = await flattenScene(final, lookup)
      const name = annotatedName(opened.name, replace)
      const accepted = onSave(
        { kind: 'image', data, mimeType: 'image/png', name, annotation: final },
        replace,
      )
      if (!accepted) {
        setSaving(false)
        toast('No room for this image: send or remove some attachments first.', 'error')
      }
    } catch (error) {
      setSaving(false)
      toast(`Could not save the annotated image: ${ipcErrorText(error)}`, 'error')
    }
  }

  const dirty = (history?.past.length ?? 0) > 0 || textEdit !== null
  const cancel = (): void => {
    if (dirty && !discardArmed) setDiscardArmed(true)
    else onCancel()
  }

  /** Escape peels one layer at a time: text, then selection, then the editor. */
  const onEscape = (): void => {
    if (textEditRef.current) finishText()
    else if (selectedId) setSelectedId(null)
    else cancel()
  }

  const onKeyDown = (event: React.KeyboardEvent): void => {
    event.stopPropagation()
    // Only the annotation's own text field keeps its keys. The canvas never
    // takes focus, so after the checkbox is clicked focus stays there, and
    // ignoring inputs too left every shortcut dead until the next Tab.
    if ((event.target as HTMLElement).tagName === 'TEXTAREA') return
    const mod = event.metaKey || event.ctrlKey
    const key = event.key.toLowerCase()
    if (mod && key === 'z') {
      event.preventDefault()
      stepHistory(event.shiftKey ? redo : undo)
    } else if (mod && key === 'enter') {
      event.preventDefault()
      void done()
    } else if (mod && event.shiftKey && key === 'v') {
      event.preventDefault()
      void fromClipboard('replace')
    } else if (!mod && !event.altKey && (key === 'backspace' || key === 'delete') && selected) {
      event.preventDefault()
      deleteSelected()
    } else if (!mod && !event.altKey) {
      const match = TOOLS.find((t) => t.key === key)
      if (match) setTool(match.tool)
    }
  }

  const editing = textEdit?.shape
  return (
    <ModalOverlay onClose={onEscape} backdrop="photo" closeOnBackdrop={false}>
      <div
        ref={rootRef}
        tabIndex={-1}
        role="dialog"
        aria-label="Annotate image"
        onKeyDown={onKeyDown}
        onPaste={(event) => {
          event.stopPropagation()
          if ((event.target as HTMLElement).tagName === 'TEXTAREA') return
          if (fromFiles([...event.clipboardData.files])) event.preventDefault()
        }}
        // A portal still bubbles React events to its React parents, and this
        // one is rendered inside the composer's drop zone: unstopped, a drop
        // here would ALSO attach the file to the composer.
        onDragOver={(event) => {
          event.stopPropagation()
          if (event.dataTransfer.types.includes('Files')) event.preventDefault()
        }}
        onDragLeave={(event) => event.stopPropagation()}
        onDrop={(event) => {
          event.stopPropagation()
          if (fromFiles([...event.dataTransfer.files])) event.preventDefault()
        }}
        className="border-border bg-surface-raised flex h-[92vh] w-[94vw] flex-col overflow-hidden rounded-xl border shadow-2xl outline-none"
      >
        <EditorToolbar
          tool={tool}
          onTool={setTool}
          color={color}
          onColor={recolor}
          size={size}
          onSize={resize}
          canUndo={(history?.past.length ?? 0) > 0}
          canRedo={(history?.future.length ?? 0) > 0}
          onUndo={() => stepHistory(undo)}
          onRedo={() => stepHistory(redo)}
          canDelete={selected !== null && tool === 'select'}
          onDelete={deleteSelected}
          onPaste={() => void fromClipboard('layer')}
          onReplace={() => void fromClipboard('replace')}
        />

        <div
          ref={stageRef}
          className="bg-bg-secondary flex min-h-0 flex-1 items-center justify-center overflow-hidden p-4"
        >
          {loadError && <p className="text-text-secondary text-base">{loadError}</p>}
          {scene && zoom > 0 && (
            <div
              className="relative shadow-lg"
              style={{ width: scene.base.width * zoom, height: scene.base.height * zoom }}
            >
              <canvas
                ref={canvasRef}
                data-testid="image-editor-canvas"
                width={scene.base.width}
                height={scene.base.height}
                onPointerDown={onPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={onPointerUp}
                onPointerCancel={onPointerUp}
                onDoubleClick={onDoubleClick}
                // Keeps focus on the editor (and on text being typed): a
                // mousedown here would otherwise move it before our handler.
                onMouseDown={(event) => event.preventDefault()}
                className="block h-full w-full touch-none"
                style={{
                  cursor: tool === 'select' ? 'default' : tool === 'text' ? 'text' : 'crosshair',
                }}
              />
              {editing && (
                <textarea
                  autoFocus
                  aria-label="Annotation text"
                  value={editing.text}
                  rows={1}
                  onChange={(event) => {
                    const edit = textEditRef.current
                    if (edit)
                      setTextEdit({ ...edit, shape: { ...edit.shape, text: event.target.value } })
                  }}
                  onBlur={() => finishText()}
                  onKeyDown={(event) => {
                    if (event.key === 'Enter' && (event.metaKey || event.ctrlKey)) {
                      event.preventDefault()
                      void done()
                    } else if (event.key === 'Enter' && !event.shiftKey) {
                      event.preventDefault()
                      finishText()
                    }
                  }}
                  spellCheck={false}
                  className="absolute resize-none overflow-hidden whitespace-pre border-0 bg-transparent p-0 outline-none"
                  style={
                    {
                      left: editing.at.x * zoom,
                      top: editing.at.y * zoom,
                      font: textFont(editing.size * zoom),
                      lineHeight: TEXT_LINE_HEIGHT,
                      color: editing.color,
                      textShadow: `0 0 3px ${contrastFor(editing.color)}, 0 0 1px ${contrastFor(editing.color)}`,
                      caretColor: editing.color,
                      fieldSizing: 'content',
                      minWidth: '1ch',
                    } as React.CSSProperties
                  }
                />
              )}
            </div>
          )}
        </div>

        <div className="border-border flex flex-wrap items-center gap-3 border-t px-4 py-2.5">
          {discardArmed ? (
            <>
              <span className="text-text mr-auto text-base">Discard your annotations?</span>
              <Button size="sm" onClick={() => setDiscardArmed(false)}>
                Keep editing
              </Button>
              <Button size="sm" variant="danger" onClick={onCancel}>
                Discard
              </Button>
            </>
          ) : (
            <>
              <span className="text-text-tertiary mr-auto text-sm">
                Hold Shift for a square or circle · {formatShortcut('mod', 'V')} pastes an image on
                top · Esc closes
              </span>
              <TooltipLabel
                className="text-text-secondary flex cursor-pointer items-center gap-2 text-base"
                data-tooltip={
                  replace
                    ? 'The annotated image takes the original’s place'
                    : 'Keeps the original and adds the annotated copy next to it'
                }
              >
                <input
                  type="checkbox"
                  checked={replace}
                  onChange={(event) => setReplace(event.target.checked)}
                />
                Replace original
              </TooltipLabel>
              <Button size="sm" onClick={cancel}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="primary"
                disabled={!history || saving}
                onClick={() => void done()}
              >
                {saving ? 'Saving…' : 'Done'}
              </Button>
            </>
          )}
        </div>
      </div>
    </ModalOverlay>
  )
}
