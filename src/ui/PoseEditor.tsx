import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { PointId, Setup, Vec2 } from '../solver/types'
import { constraintFor, locate } from '../solver/constraints'
import { previewLayout } from '../solver/solve'
import {
  type Theme,
  LIGHT_THEME,
  DARK_THEME,
  computePtsBounds,
  makeProjector,
  drawGrid,
  drawAxes,
  drawArrow,
  drawControlPoint,
  drawInteriorPoint,
  usePrefersDark,
} from '../player/canvasKit'
import type { Bounds } from '../player/canvasKit'
import { addCurveThrough, addFixPointAt, addFreePoint, clearSpan, moveFixTo, removeLastFreePoint } from './setupEdits'
import { simplifyStroke } from './sketch'
import './poseEditor.css'

export interface PoseEditorProps {
  setup: Setup
  /** Applies an edit; `history: false` replaces the setup without adding an undo step. */
  edit: (mutator: (setup: Setup) => Setup, options?: { history?: boolean }) => void
  onUndo: () => void
  onRedo: () => void
  canUndo: boolean
  canRedo: boolean
  /** Curve shown highlighted (and edited in sketch mode). */
  activeCurve: number
  onActiveCurve: (curve: number) => void
  /** Guide point mode: tap to drop guide points between control points. */
  sketch?: boolean
  /** Drawing mode: move, add and sketch control points and curves right on the canvas. */
  draw?: boolean
  /** Control point shown with a ring (the one being edited elsewhere). */
  selectedPoint?: PointId | null
  /** Called when a control point is tapped in drawing mode. */
  onSelectPoint?: (id: PointId) => void
}

type Tool = 'move' | 'add' | 'sketch'

/** Pointer distance (px) within which a tap grabs a control point. */
const HIT_RADIUS = 16
/** Simplification tolerance (px) of a sketched stroke. */
const STROKE_TOLERANCE = 14
/** Smallest stroke length (px) that becomes a curve. */
const MIN_STROKE = 24

const MIN_ZOOM = 0.25
const MAX_ZOOM = 12
const DRAG_THRESHOLD = 4

interface View {
  zoom: number
  x: number
  y: number
}

interface ViewProjector {
  scale: number
  cx: number
  cy: number
  toX: (x: number) => number
  toY: (y: number) => number
  worldX: (sx: number) => number
  worldY: (sy: number) => number
}

/** Fit-then-zoom-about-bounds-center projector with an extra screen pan. */
function makeViewProjector(bounds: Bounds, width: number, height: number, view: View): ViewProjector {
  const base = makeProjector(bounds, width, height)
  const scale = Math.max(base.scale * view.zoom, 1e-9)
  return {
    scale,
    cx: base.cx,
    cy: base.cy,
    toX: (x) => width / 2 + (x - base.cx) * scale + view.x,
    toY: (y) => height / 2 - (y - base.cy) * scale + view.y,
    worldX: (sx) => base.cx + (sx - width / 2 - view.x) / scale,
    worldY: (sy) => base.cy - (sy - height / 2 - view.y) / scale,
  }
}

function screenPoints(pts: Vec2[], project: ViewProjector): [number, number][] {
  return pts.map(([x, y]) => [project.toX(x), project.toY(y)])
}

function drawScene(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  preview: Vec2[][],
  controlIndices: number[][],
  setup: Setup,
  activeCurve: number,
  activeSpan: number,
  project: ViewProjector,
  theme: Theme,
  ghost: Vec2 | null,
  selected: PointId | null,
  stroke: Vec2[],
) {
  ctx.fillStyle = theme.bg
  ctx.fillRect(0, 0, width, height)
  drawGrid(ctx, project, width, height, theme)
  drawAxes(ctx, project, width, height, theme)

  setup.curves.forEach((curve, ci) => {
    const pts = preview[ci]
    if (!pts || pts.length < 2) return
    const screen = screenPoints(pts, project)
    const ctrl = controlIndices[ci] ?? []
    const isActive = ci === activeCurve

    ctx.save()
    ctx.globalAlpha = isActive ? 1 : 0.4

    ctx.strokeStyle = theme.chain
    ctx.lineWidth = 2.4
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.beginPath()
    ctx.moveTo(screen[0][0], screen[0][1])
    for (let i = 1; i < screen.length; i += 1) ctx.lineTo(screen[i][0], screen[i][1])
    ctx.stroke()

    if (isActive) {
      const fix = ctrl
      const from = fix[activeSpan]
      const to = fix[activeSpan + 1]
      if (from !== undefined && to !== undefined && screen[from] && screen[to]) {
        ctx.strokeStyle = theme.point
        ctx.lineWidth = 3.4
        ctx.beginPath()
        ctx.moveTo(screen[from][0], screen[from][1])
        for (let i = from + 1; i <= to; i += 1) ctx.lineTo(screen[i][0], screen[i][1])
        ctx.stroke()
      }
    }

    ctx.strokeStyle = theme.orient
    ctx.lineWidth = 1.4
    ctx.setLineDash([5, 4])
    curve.fixPoints.forEach((fp, pi) => {
      if (!fp.orientation) return
      const len = Math.hypot(fp.orientation[0], fp.orientation[1])
      if (len < 1e-9) return
      const p = screen[ctrl[pi]]
      if (!p) return
      const ex = project.toX(fp.pos[0] + (fp.orientation[0] / len) * 1e6)
      const ey = project.toY(fp.pos[1] + (fp.orientation[1] / len) * 1e6)
      ctx.beginPath()
      ctx.moveTo(p[0], p[1])
      ctx.lineTo(ex, ey)
      ctx.stroke()
    })
    ctx.setLineDash([])

    curve.fixPoints.forEach((fp, pi) => {
      if (!fp.orientation) return
      const p = screen[ctrl[pi]]
      if (!p) return
      const len = Math.hypot(fp.orientation[0], fp.orientation[1])
      if (len < 1e-9) return
      const ux = fp.orientation[0] / len
      const uy = fp.orientation[1] / len
      drawArrow(ctx, p[0], p[1], p[0] + ux * 30, p[1] - uy * 30, theme.orient)
    })

    const isControl = new Set(ctrl)
    screen.forEach((p, i) => {
      if (!isControl.has(i)) drawInteriorPoint(ctx, p[0], p[1], theme)
    })
    curve.fixPoints.forEach((fp, pi) => {
      const p = screen[ctrl[pi]]
      if (p) drawControlPoint(ctx, p[0], p[1], fp.posFree === true, theme)
    })

    ctx.restore()
  })

  const selectedRef = selected ? locate(setup, selected) : null
  if (selectedRef) {
    const idx = controlIndices[selectedRef.curve]?.[selectedRef.point]
    const pts = preview[selectedRef.curve]
    if (idx !== undefined && pts?.[idx]) {
      ctx.save()
      ctx.strokeStyle = theme.point
      ctx.lineWidth = 2.4
      ctx.beginPath()
      ctx.arc(project.toX(pts[idx][0]), project.toY(pts[idx][1]), 11, 0, Math.PI * 2)
      ctx.stroke()
      ctx.restore()
    }
  }

  if (stroke.length > 1) {
    ctx.save()
    ctx.strokeStyle = theme.point
    ctx.lineWidth = 2
    ctx.setLineDash([6, 4])
    ctx.beginPath()
    ctx.moveTo(project.toX(stroke[0][0]), project.toY(stroke[0][1]))
    for (const p of stroke.slice(1)) ctx.lineTo(project.toX(p[0]), project.toY(p[1]))
    ctx.stroke()
    ctx.restore()
  }

  if (ghost) {
    ctx.save()
    ctx.globalAlpha = 0.6
    ctx.strokeStyle = theme.point
    ctx.lineWidth = 1.6
    ctx.beginPath()
    ctx.arc(project.toX(ghost[0]), project.toY(ghost[1]), 4.5, 0, Math.PI * 2)
    ctx.stroke()
    ctx.restore()
  }
}

function UndoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M3 7v6h6" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M21 17a9 9 0 0 0-9-9H3" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function RedoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M21 7v6h-6" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M3 17a9 9 0 0 1 9-9h9" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />
      <path d="M10 11v6M14 11v6" stroke="currentColor" strokeWidth="1.9" strokeLinecap="round" />
    </svg>
  )
}

export function PoseEditor({
  setup,
  edit,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
  activeCurve: activeCurveProp,
  onActiveCurve,
  sketch = false,
  draw = false,
  selectedPoint = null,
  onSelectPoint,
}: PoseEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [ghost, setGhost] = useState<Vec2 | null>(null)
  const [view, setView] = useState<View>({ zoom: 1, x: 0, y: 0 })
  const [activeSpanRaw, setActiveSpan] = useState(0)
  const dark = usePrefersDark()
  const theme = dark ? DARK_THEME : LIGHT_THEME

  const [tool, setTool] = useState<Tool>('move')
  const [stroke, setStroke] = useState<Vec2[]>([])
  // The view fits the curves; while a point is dragged the fit is frozen so the picture does not rescale under the pointer.
  const [frozenBounds, setFrozenBounds] = useState<Bounds | null>(null)

  const dragRef = useRef<
    | { kind: 'pan'; x: number; y: number; moved: boolean }
    | { kind: 'point'; id: PointId; x: number; y: number; moved: boolean; movable: boolean }
    | { kind: 'stroke'; points: Vec2[] }
    | null
  >(null)

  const activeCurve = Math.min(Math.max(activeCurveProp, 0), Math.max(setup.curves.length - 1, 0))
  const curve = setup.curves[activeCurve]
  const spanCount = Math.max(0, (curve?.fixPoints.length ?? 0) - 1)
  const activeSpan = Math.min(Math.max(activeSpanRaw, 0), Math.max(spanCount - 1, 0))

  const layout = useMemo(() => previewLayout(setup), [setup])
  const preview = layout.curves
  const controlIndices = layout.controlIndices
  const liveBounds = useMemo(() => computePtsBounds(preview.flat()), [preview])
  const bounds = frozenBounds ?? liveBounds

  const placed = curve?.spans[activeSpan]?.length ?? 0

  useEffect(() => {
    const container = containerRef.current
    if (!container) return
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0]
      if (!entry) return
      const { width, height } = entry.contentRect
      setSize({ width, height })
    })
    observer.observe(container)
    return () => observer.disconnect()
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas || size.width <= 0 || size.height <= 0) return
    const dpr = window.devicePixelRatio || 1
    canvas.width = Math.max(1, Math.round(size.width * dpr))
    canvas.height = Math.max(1, Math.round(size.height * dpr))
    const ctx = canvas.getContext('2d')
    if (!ctx) return
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0)
    const project = makeViewProjector(bounds, size.width, size.height, view)
    drawScene(ctx, size.width, size.height, preview, controlIndices, setup, activeCurve, activeSpan, project, theme, ghost, selectedPoint, stroke)
  }, [preview, controlIndices, bounds, size, view, theme, setup, activeCurve, activeSpan, ghost, selectedPoint, stroke])

  // Wheel zoom must be non-passive to call preventDefault.
  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const onWheel = (event: WheelEvent) => {
      event.preventDefault()
      setView((prev) => {
        const factor = Math.exp(-event.deltaY * 0.0015)
        const nextZoom = Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, prev.zoom * factor))
        if (nextZoom === prev.zoom) return prev
        const rect = canvas.getBoundingClientRect()
        const sx = event.clientX - rect.left
        const sy = event.clientY - rect.top
        const base = makeProjector(bounds, size.width, size.height)
        const old = prev.zoom
        const wx = base.cx + (sx - size.width / 2 - prev.x) / (base.scale * old)
        const wy = base.cy - (sy - size.height / 2 - prev.y) / (base.scale * old)
        const scale = base.scale * nextZoom
        return {
          zoom: nextZoom,
          x: sx - size.width / 2 - (wx - base.cx) * scale,
          y: sy - size.height / 2 + (wy - base.cy) * scale,
        }
      })
    }
    canvas.addEventListener('wheel', onWheel, { passive: false })
    return () => canvas.removeEventListener('wheel', onWheel)
  }, [bounds, size])

  const localPoint = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  const worldAt = (px: number, py: number): Vec2 | null => {
    if (size.width <= 0 || size.height <= 0) return null
    const project = makeViewProjector(bounds, size.width, size.height, view)
    return [project.worldX(px), project.worldY(py)]
  }

  /** The control point under the pointer, if any (nearest within reach). */
  const hitControlPoint = (px: number, py: number): { ci: number; pi: number; id: PointId } | null => {
    if (size.width <= 0 || size.height <= 0) return null
    const project = makeViewProjector(bounds, size.width, size.height, view)
    let best: { ci: number; pi: number; id: PointId } | null = null
    let bestDist = HIT_RADIUS
    setup.curves.forEach((c, ci) => {
      c.fixPoints.forEach((fp, pi) => {
        const p = preview[ci]?.[controlIndices[ci]?.[pi]]
        if (!p) return
        const d = Math.hypot(project.toX(p[0]) - px, project.toY(p[1]) - py)
        if (d <= bestDist) {
          best = { ci, pi, id: fp.id }
          bestDist = d
        }
      })
    })
    return best
  }

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    event.currentTarget.setPointerCapture?.(event.pointerId)
    const point = localPoint(event)
    if (draw && point && tool === 'sketch') {
      const world = worldAt(point.x, point.y)
      if (world) {
        dragRef.current = { kind: 'stroke', points: [world] }
        setFrozenBounds(liveBounds)
        setStroke([world])
        return
      }
    }
    if (draw && point && tool === 'move') {
      const hit = hitControlPoint(point.x, point.y)
      if (hit) {
        dragRef.current = {
          kind: 'point',
          id: hit.id,
          x: event.clientX,
          y: event.clientY,
          moved: false,
          movable: !constraintFor(setup, 'position', hit.id),
        }
        return
      }
    }
    dragRef.current = { kind: 'pan', x: event.clientX, y: event.clientY, moved: false }
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current
    const point = localPoint(event)
    if (drag?.kind === 'stroke') {
      const world = point && worldAt(point.x, point.y)
      if (world) {
        drag.points.push(world)
        setStroke([...drag.points])
      }
    } else if (drag?.kind === 'point') {
      const dx = event.clientX - drag.x
      const dy = event.clientY - drag.y
      if (!drag.moved && Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) {
        drag.moved = true
        if (drag.movable) setFrozenBounds(liveBounds)
        if (drag.movable) edit((s) => ({ ...s }))
      }
      const world = point && worldAt(point.x, point.y)
      if (drag.moved && drag.movable && world) {
        const id = drag.id
        edit(
          (s) => {
            const ref = locate(s, id)
            return ref ? moveFixTo(s, ref.curve, ref.point, world) : s
          },
          { history: false },
        )
      }
    } else if (drag) {
      const dx = event.clientX - drag.x
      const dy = event.clientY - drag.y
      if (Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) drag.moved = true
      if (drag.moved) {
        drag.x = event.clientX
        drag.y = event.clientY
        setView((prev) => ({ ...prev, x: prev.x + dx, y: prev.y + dy }))
      }
    }
    if ((sketch || (draw && tool === 'add')) && event.pointerType === 'mouse' && point) {
      setGhost(worldAt(point.x, point.y))
    }
  }

  // A tap (pointer released without dragging) places a guide/control point; a finished stroke becomes a curve.
  const handlePointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current
    dragRef.current = null
    setStroke([])
    setFrozenBounds(null)
    if (!drag) return

    if (drag.kind === 'stroke') {
      const project = makeViewProjector(bounds, size.width, size.height, view)
      let pixels = 0
      for (let i = 1; i < drag.points.length; i++) {
        pixels +=
          Math.hypot(drag.points[i][0] - drag.points[i - 1][0], drag.points[i][1] - drag.points[i - 1][1]) *
          project.scale
      }
      if (pixels < MIN_STROKE) return
      const simplified = simplifyStroke(drag.points, STROKE_TOLERANCE / project.scale)
      if (simplified.length < 2) return
      edit((s) => addCurveThrough(s, simplified))
      onActiveCurve(setup.curves.length)
      return
    }

    if (drag.moved) return
    const point = localPoint(event)
    if (!point) return
    if (drag.kind === 'point') {
      onSelectPoint?.(drag.id)
      return
    }
    const world = worldAt(point.x, point.y)
    if (!world || !world.every(Number.isFinite)) return
    if (draw && tool === 'add' && curve) {
      edit((s) => addFixPointAt(s, activeCurve, world))
      return
    }
    if (draw && tool === 'move') {
      const hit = hitControlPoint(point.x, point.y)
      if (hit) onSelectPoint?.(hit.id)
      return
    }
    if (sketch && spanCount > 0) edit((s) => addFreePoint(s, activeCurve, activeSpan, world))
  }

  const handleRemoveLast = useCallback(() => {
    edit((s) => removeLastFreePoint(s, activeCurve, activeSpan))
  }, [edit, activeCurve, activeSpan])

  useEffect(() => {
    if (!sketch && !draw) return
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const tag = target?.tagName
      if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT' || target?.isContentEditable) return
      const mod = event.ctrlKey || event.metaKey
      const key = event.key.toLowerCase()
      if (mod && key === 'z') {
        event.preventDefault()
        if (event.shiftKey) onRedo()
        else onUndo()
        return
      }
      if (mod && key === 'y') {
        event.preventDefault()
        onRedo()
        return
      }
      if (sketch && (key === 'backspace' || key === 'delete')) {
        event.preventDefault()
        handleRemoveLast()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [sketch, draw, handleRemoveLast, onUndo, onRedo])

  const zoomBy = (factor: number) =>
    setView((prev) => ({
      ...prev,
      zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, prev.zoom * factor)),
    }))

  const resetView = () => setView({ zoom: 1, x: 0, y: 0 })

  return (
    <div className={`pose-editor ${sketch ? 'pose-editor--sketch' : ''} ${draw ? `pose-editor--draw pose-editor--${tool}` : ''}`}>
      {draw ? (
        <div className="pose-editor__tools">
          <div className="chip-row" role="group" aria-label="Drawing tool">
            {(
              [
                ['move', 'Move points'],
                ['add', `Add points to curve ${activeCurve + 1}`],
                ['sketch', 'Sketch a new curve'],
              ] as [Tool, string][]
            ).map(([id, text]) => (
              <button
                key={id}
                type="button"
                className={`chip ${tool === id ? 'is-active' : ''}`}
                aria-pressed={tool === id}
                onClick={() => setTool(id)}
              >
                {text}
              </button>
            ))}
          </div>
          <p className="pose-editor__hint">
            {tool === 'move'
              ? 'Drag a point to move it, tap it to edit its details below. Drag the background to pan.'
              : tool === 'add'
                ? 'Tap to add the next point to the highlighted curve.'
                : 'Draw a rough line with your finger or mouse. It becomes a new curve through a few points you can adjust.'}
          </p>
        </div>
      ) : null}
      {sketch ? (
        <div className="pose-editor__selectors">
          <div className="chip-row" role="tablist" aria-label="Curves">
            {setup.curves.map((_, ci) => (
              <button
                key={ci}
                type="button"
                role="tab"
                aria-selected={ci === activeCurve}
                className={`chip ${ci === activeCurve ? 'is-active' : ''}`}
                onClick={() => {
                  onActiveCurve(ci)
                  setActiveSpan(0)
                }}
              >
                Curve {ci + 1}
              </button>
            ))}
          </div>
          {spanCount > 1 ? (
            <div className="chip-row" role="tablist" aria-label="Sections of the curve">
              {Array.from({ length: spanCount }, (_, si) => (
                <button
                  key={si}
                  type="button"
                  role="tab"
                  aria-selected={si === activeSpan}
                  className={`chip chip--sm ${si === activeSpan ? 'is-active' : ''}`}
                  onClick={() => setActiveSpan(si)}
                >
                  Between points {si + 1}–{si + 2}
                </button>
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      <div className="pose-editor__canvas" ref={containerRef}>
        <canvas
          ref={canvasRef}
          role="img"
          aria-label={sketch ? 'Sketch area: tap to place guide points' : draw ? 'Drawing area' : 'Preview of your curves'}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={() => {
            dragRef.current = null
            setStroke([])
            setFrozenBounds(null)
          }}
          onPointerLeave={() => setGhost(null)}
        />
      </div>

      <div className="pose-editor__bar">
        {sketch || draw ? (
          <div className="pose-editor__actions" role="group" aria-label="Edit history">
            <button type="button" className="btn btn--sm" data-action="undo" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={onUndo}>
              <UndoIcon /> Undo
            </button>
            <button type="button" className="btn btn--sm" data-action="redo" title="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={onRedo}>
              <RedoIcon /> Redo
            </button>
            {sketch ? <button
              type="button"
              className="btn btn--sm"
              data-action="clear"
              title="Remove the guide points of this section"
              disabled={placed === 0}
              onClick={() => edit((s) => clearSpan(s, activeCurve, activeSpan))}
            >
              <TrashIcon /> Clear guides{placed > 0 ? ` (${placed})` : ''}
            </button> : null}
          </div>
        ) : (
          <span className="pose-editor__caption">Preview only · drag to pan, scroll to zoom</span>
        )}

        <div className="pose-editor__zoom" role="group" aria-label="View zoom">
          <button type="button" className="btn btn--sm" data-action="zoom-out" aria-label="Zoom out" title="Zoom out" onClick={() => zoomBy(1 / 1.25)}>
            −
          </button>
          <button type="button" className="btn btn--sm" data-action="zoom-reset" title="Reset zoom" onClick={resetView}>
            Fit
          </button>
          <button type="button" className="btn btn--sm" data-action="zoom-in" aria-label="Zoom in" title="Zoom in" onClick={() => zoomBy(1.25)}>
            +
          </button>
        </div>
      </div>
    </div>
  )
}

export default PoseEditor
