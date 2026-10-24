import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import type { Setup, Vec2 } from '../solver/types'
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
import { addFreePoint, clearSpan, removeLastFreePoint } from './setupEdits'
import './poseEditor.css'

export interface PoseEditorProps {
  setup: Setup
  /** Applies an edit; `history: false` replaces the setup without adding an undo step. */
  edit: (mutator: (setup: Setup) => Setup, options?: { history?: boolean }) => void
  onUndo: () => void
  onRedo: () => void
  canUndo: boolean
  canRedo: boolean
  /** Curve shown highlighted and edited. */
  activeCurve: number
  onActiveCurve: (curve: number) => void
  /** Guide point mode: tap to drop guide points between control points. */
  sketch?: boolean
}

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
}: PoseEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [ghost, setGhost] = useState<Vec2 | null>(null)
  const [view, setView] = useState<View>({ zoom: 1, x: 0, y: 0 })
  const [activeSpanRaw, setActiveSpan] = useState(0)
  const dark = usePrefersDark()
  const theme = dark ? DARK_THEME : LIGHT_THEME


  const dragRef = useRef<
    { x: number; y: number; moved: boolean } | null
  >(null)

  const activeCurve = Math.min(Math.max(activeCurveProp, 0), Math.max(setup.curves.length - 1, 0))
  const curve = setup.curves[activeCurve]
  const spanCount = Math.max(0, (curve?.fixPoints.length ?? 0) - 1)
  const activeSpan = Math.min(Math.max(activeSpanRaw, 0), Math.max(spanCount - 1, 0))

  const layout = useMemo(() => previewLayout(setup), [setup])
  const preview = layout.curves
  const controlIndices = layout.controlIndices
  const bounds = useMemo(() => computePtsBounds(preview.flat()), [preview])

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
    drawScene(ctx, size.width, size.height, preview, controlIndices, setup, activeCurve, activeSpan, project, theme, ghost)
  }, [preview, controlIndices, bounds, size, view, theme, setup, activeCurve, activeSpan, ghost])

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

  const handlePointerDown = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    if (event.pointerType === 'mouse' && event.button !== 0) return
    event.currentTarget.setPointerCapture?.(event.pointerId)
    dragRef.current = { x: event.clientX, y: event.clientY, moved: false }
  }

  const handlePointerMove = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current
    const point = localPoint(event)
    if (drag) {
      const dx = event.clientX - drag.x
      const dy = event.clientY - drag.y
      if (Math.abs(dx) + Math.abs(dy) > DRAG_THRESHOLD) drag.moved = true
      if (drag.moved) {
        drag.x = event.clientX
        drag.y = event.clientY
        setView((prev) => ({ ...prev, x: prev.x + dx, y: prev.y + dy }))
      }
    }
    if (sketch && event.pointerType === 'mouse' && point) setGhost(worldAt(point.x, point.y))
  }

  // A tap (pointer released without dragging) places a guide point.
  const handlePointerUp = (event: ReactPointerEvent<HTMLCanvasElement>) => {
    const drag = dragRef.current
    dragRef.current = null
    if (!drag || drag.moved) return
    const point = localPoint(event)
    if (!point) return
    const world = worldAt(point.x, point.y)
    if (!world || !world.every(Number.isFinite)) return
    if (sketch && spanCount > 0) edit((s) => addFreePoint(s, activeCurve, activeSpan, world))
  }

  const handleRemoveLast = useCallback(() => {
    edit((s) => removeLastFreePoint(s, activeCurve, activeSpan))
  }, [edit, activeCurve, activeSpan])

  useEffect(() => {
    if (!sketch) return
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
      if (key === 'backspace' || key === 'delete') {
        event.preventDefault()
        handleRemoveLast()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [sketch, handleRemoveLast, onUndo, onRedo])

  const zoomBy = (factor: number) =>
    setView((prev) => ({
      ...prev,
      zoom: Math.min(MAX_ZOOM, Math.max(MIN_ZOOM, prev.zoom * factor)),
    }))

  const resetView = () => setView({ zoom: 1, x: 0, y: 0 })

  return (
    <div className={`pose-editor ${sketch ? 'pose-editor--sketch' : ''}`}>
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
          aria-label={sketch ? 'Sketch area: tap to place guide points' : 'Preview of your curves'}
          onPointerDown={handlePointerDown}
          onPointerMove={handlePointerMove}
          onPointerUp={handlePointerUp}
          onPointerCancel={() => {
            dragRef.current = null
          }}
          onPointerLeave={() => setGhost(null)}
        />
      </div>

      <div className="pose-editor__bar">
        {sketch ? (
          <div className="pose-editor__actions" role="group" aria-label="Edit history">
            <button type="button" className="btn btn--sm" data-action="undo" title="Undo (Ctrl+Z)" disabled={!canUndo} onClick={onUndo}>
              <UndoIcon /> Undo
            </button>
            <button type="button" className="btn btn--sm" data-action="redo" title="Redo (Ctrl+Shift+Z)" disabled={!canRedo} onClick={onRedo}>
              <RedoIcon /> Redo
            </button>
            <button
              type="button"
              className="btn btn--sm"
              data-action="clear"
              title="Remove the guide points of this section"
              disabled={placed === 0}
              onClick={() => edit((s) => clearSpan(s, activeCurve, activeSpan))}
            >
              <TrashIcon /> Clear guides{placed > 0 ? ` (${placed})` : ''}
            </button>
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
