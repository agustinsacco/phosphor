import ForceGraph3D from '3d-force-graph'
import { graphActivity, type BrainForceGraph } from './graphActivity'
import { graphAppearance } from './graphAppearance'
import { readGraphTheme } from './graphColors'
import type { GraphModel } from './graphModel'

export interface GraphSelection {
  focus: string | null
  matches: Set<string> | null
}
export interface GraphScene {
  update: (model: GraphModel, selection: GraphSelection) => void
  zoom: (factor: number) => void
  fit: () => void
  dispose: () => void
}

/** This entire module (including Three) is loaded only when a graph is mounted. */
export function createGraphScene(
  container: HTMLElement,
  onFocus: (id: string) => void,
): GraphScene {
  // The vendor constructor fixes its generic defaults; this scene is the sole graphData writer.
  const graph = new ForceGraph3D(container, {
    controlType: 'orbit',
    rendererConfig: { alpha: true },
  }) as unknown as BrainForceGraph
  try {
    return new SceneController(graph, container, onFocus)
  } catch (error) {
    graph._destructor()
    throw error
  }
}

class SceneController implements GraphScene {
  private model: GraphModel = { nodes: [], links: [] }
  private selection: GraphSelection = { focus: null, matches: null }
  private hover: string | null = null
  private theme = readGraphTheme()
  private pendingCamera = false
  private settled = false
  private userCamera = false
  private width = 0
  private height = 0
  private focusCamera = false
  private motion = window.matchMedia?.('(prefers-reduced-motion: reduce)')
  private activity: ReturnType<typeof graphActivity>
  private appearance: ReturnType<typeof graphAppearance>
  private observer: ResizeObserver
  private themeObserver: MutationObserver

  constructor(
    private graph: BrainForceGraph,
    container: HTMLElement,
    onFocus: (id: string) => void,
  ) {
    this.activity = graphActivity(graph, container, () => {
      this.userCamera = true
    })
    this.appearance = graphAppearance(graph)
    graph
      .backgroundColor('rgba(0,0,0,0)')
      .showNavInfo(false)
      .nodeLabel('')
      .linkLabel('')
      .nodeVal('val')
      .nodeRelSize(4)
      .nodeOpacity(1)
      .linkOpacity(1)
      .linkWidth((link) => 0.4 + Math.sqrt(link.count) * 0.4)
      .onNodeClick((node) => onFocus(node.id))
      .onNodeHover((node) => {
        this.hover = node?.id ?? null
        this.paint()
      })
      .onNodeDrag(() => this.activity.reheat())
      .onNodeDragEnd(() => this.activity.wake())
      .onEngineStop(() => {
        if (this.pendingCamera) {
          this.pendingCamera = false
          this.settled = true
          if (!this.userCamera) this.aim()
        }
        this.activity.cooled()
      })
    this.setMotion()
    const resize = (): void => {
      const { width, height } = container.getBoundingClientRect()
      if (width === this.width && height === this.height) return
      this.width = width
      this.height = height
      graph.width(Math.max(1, width)).height(Math.max(1, height))
      this.activity.wake()
      if (this.settled && !this.userCamera && !this.selection.focus && !this.selection.matches)
        graph.zoomToFit(0, 16)
    }
    this.observer = new ResizeObserver(resize)
    this.observer.observe(container)
    resize()
    this.themeObserver = new MutationObserver(() => {
      this.theme = readGraphTheme()
      this.paint()
    })
    this.themeObserver.observe(document.documentElement, {
      attributes: true,
      attributeFilter: ['class'],
    })
    this.motion?.addEventListener('change', this.setMotion)
  }

  private duration = (): number => (this.motion?.matches ? 0 : 600)
  private paint = (): void => {
    this.appearance.paint(this.hover, this.selection.matches, this.theme)
    this.activity.wake()
  }
  private aim = (): void => {
    this.activity.wake(this.duration() + 100)
    const node =
      this.focusCamera && this.model.nodes.find((item) => item.id === this.selection.focus)
    if (node && Number.isFinite(node.x)) {
      const target = { x: node.x ?? 0, y: node.y ?? 0, z: node.z ?? 0 }
      this.graph.cameraPosition({ ...target, z: target.z + 120 }, target, this.duration())
    } else
      this.graph.zoomToFit(
        this.duration(),
        16,
        (item) => !this.selection.matches || this.selection.matches.has(item.id),
      )
  }
  private setMotion = (): void => {
    this.graph
      .warmupTicks(this.motion?.matches ? 300 : 0)
      .cooldownTicks(this.motion?.matches ? 0 : 300)
    this.activity.reheat()
    if (this.model.nodes.length) {
      this.graph.graphData({ nodes: this.model.nodes, links: this.model.links })
    }
    this.aim()
    this.pendingCamera = this.model.nodes.length > 0
  }

  update(model: GraphModel, selection: GraphSelection): void {
    const changed = model !== this.model
    const selectionChanged =
      selection.focus !== this.selection.focus || selection.matches !== this.selection.matches
    if (selection.focus !== this.selection.focus) this.focusCamera = !!selection.focus
    if (selection.matches !== this.selection.matches) this.focusCamera = false
    if (selectionChanged) this.userCamera = false
    this.selection = selection
    if (changed) {
      const previous = new Map(this.model.nodes.map((node) => [node.id, node]))
      this.model = model
      for (const node of model.nodes) {
        const old = previous.get(node.id)
        if (old) {
          node.x = old.x
          node.y = old.y
          node.z = old.z
        }
      }
      this.appearance.data(model)
      this.settled = false
      this.activity.reheat()
      this.graph.graphData(model)
    }
    this.paint()
    if (selectionChanged) this.aim()
    // Waking a paused graph can synchronously stop its OLD engine. Arm only after those wakes.
    if (changed) this.pendingCamera = true
  }

  fit(): void {
    this.userCamera = false
    this.activity.wake(this.duration() + 100)
    this.graph.zoomToFit(this.duration(), 16)
  }

  zoom(factor: number): void {
    this.userCamera = true
    const camera = this.graph.cameraPosition()
    const target = (this.graph.controls() as { target: { x: number; y: number; z: number } }).target
    this.activity.wake(this.duration() + 100)
    this.graph.cameraPosition(
      {
        x: target.x + (camera.x - target.x) / factor,
        y: target.y + (camera.y - target.y) / factor,
        z: target.z + (camera.z - target.z) / factor,
      },
      target,
      this.duration(),
    )
  }

  dispose(): void {
    this.observer.disconnect()
    this.themeObserver.disconnect()
    this.motion?.removeEventListener('change', this.setMotion)
    this.activity.dispose()
    this.graph._destructor()
  }
}
