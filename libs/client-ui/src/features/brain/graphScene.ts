import ForceGraph3D from '3d-force-graph'
import { graphActivity, type BrainForceGraph } from './graphActivity'
import { graphAppearance } from './graphAppearance'
import { readGraphTheme } from './graphColors'
import { Vector3, type PerspectiveCamera } from 'three'
import { fitCamera } from './graphFit'
import type { GraphLink, GraphModel } from './graphModel'

export interface GraphSelection {
  focus: string | null
  scope?: 'all' | 'near'
  matches: Set<string> | null
  path?: Set<string> | null
}
export interface GraphScene {
  update: (model: GraphModel, selection: GraphSelection) => void
  zoom: (factor: number) => void
  fit: () => void
  dimensions: (value: 2 | 3) => void
  dispose: () => void
}

/** This entire module (including Three) is loaded only when a graph is mounted. */
export function createGraphScene(
  container: HTMLElement,
  onFocus: (id: string) => void,
  onEdge: (link: GraphLink | null) => void,
  onClear: () => void = () => {},
): GraphScene {
  // The vendor constructor fixes its generic defaults; this scene is the sole graphData writer.
  const graph = new ForceGraph3D(container, {
    controlType: 'orbit',
    rendererConfig: { alpha: true },
  }) as unknown as BrainForceGraph
  try {
    return new SceneController(graph, container, onFocus, onEdge, onClear)
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
  private motion = window.matchMedia?.('(prefers-reduced-motion: reduce)')
  private activity: ReturnType<typeof graphActivity>
  private appearance: ReturnType<typeof graphAppearance>
  private observer: ResizeObserver
  private themeObserver: MutationObserver

  constructor(
    private graph: BrainForceGraph,
    container: HTMLElement,
    onFocus: (id: string) => void,
    onEdge: (link: GraphLink | null) => void,
    onClear: () => void,
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
      .linkDirectionalArrowLength(4)
      .linkDirectionalArrowRelPos(0.85)
      .onLinkHover(onEdge)
      .nodeVal('val')
      .nodeRelSize(4)
      .nodeOpacity(1)
      .linkOpacity(1)
      .linkWidth((link) => 0.4 + Math.sqrt(link.count) * 0.4)
      .onBackgroundClick(onClear)
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
      // Keep whatever the camera is framing (everything, a search or an About focus) in view.
      if (this.settled && !this.userCamera) this.aim(0)
      // The library applies the new canvas size on a later tick; keep drawing until it has.
      this.activity.wake(500)
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
    this.appearance.paint(
      this.hover,
      this.selection.matches,
      this.theme,
      this.selection.path,
      this.selection.focus,
    )
    this.activity.wake()
  }
  private aim = (duration = this.duration()): void => {
    this.activity.wake(duration + 100)
    this.fitTo(duration)
  }
  private selectionVisible(): boolean {
    const ids = new Set([
      ...(this.selection.matches ?? []),
      ...(this.selection.focus ? [this.selection.focus] : []),
    ])
    if (!ids.size) return false
    const camera = this.graph.camera() as PerspectiveCamera
    camera.updateMatrixWorld()
    return [...ids].every((id) => {
      const node = this.model.nodes.find((item) => item.id === id)
      if (!node || !Number.isFinite(node.x)) return false
      const point = new Vector3(node.x, node.y, node.z).project(camera)
      return Math.abs(point.x) <= 1 && Math.abs(point.y) <= 1 && Math.abs(point.z) <= 1
    })
  }
  /** Fit the nodes themselves, keeping the current view direction. */
  private fitTo(duration: number): void {
    const camera = this.graph.camera() as PerspectiveCamera
    camera.updateMatrixWorld()
    const e = camera.matrixWorld.elements
    const fit = fitCamera(
      this.model.nodes
        .filter((node) => Number.isFinite(node.x))
        // Sphere radius is nodeRelSize(4) * cbrt(val); the extra room keeps its label in view.
        .map((node) => ({
          x: node.x ?? 0,
          y: node.y ?? 0,
          z: node.z ?? 0,
          r: 4 * Math.cbrt(node.val) + 8,
        })),
      {
        forward: { x: -e[8]!, y: -e[9]!, z: -e[10]! },
        up: { x: e[4]!, y: e[5]!, z: e[6]! },
        fov: camera.fov,
        // The library updates camera.aspect on its next cycle; a resize fit needs the new shape now.
        aspect: this.width && this.height ? this.width / this.height : camera.aspect,
        height: this.height,
        padding: 16,
        minDistance: 250,
      },
    )
    if (fit) this.graph.cameraPosition(fit.position, fit.lookAt, duration)
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
      selection.focus !== this.selection.focus ||
      selection.matches !== this.selection.matches ||
      selection.path !== this.selection.path ||
      selection.scope !== this.selection.scope
    if (selectionChanged) {
      this.userCamera = false
      this.hover = null
    }
    this.selection = selection
    const added = model.nodes.some((node) => !this.model.nodes.some((old) => old.id === node.id))
    const shouldFit = selection.scope === 'near' || added || !this.selectionVisible()
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
    if (selectionChanged && shouldFit) this.aim()
    // Waking a paused graph can synchronously stop its OLD engine. Arm only after those wakes.
    if (changed) this.pendingCamera = !selectionChanged || shouldFit
  }

  dimensions(value: 2 | 3): void {
    this.graph.numDimensions(value)
    this.userCamera = false
    this.setMotion()
  }

  fit(): void {
    this.userCamera = false
    this.activity.wake(this.duration() + 100)
    this.fitTo(this.duration())
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
