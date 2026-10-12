import { useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import type { ProblemInput, Vec2 } from '../solver/types'
import { previewPose } from '../solver/solve'
import {
  type Theme,
  LIGHT_THEME,
  DARK_THEME,
  computePtsBounds,
  makeProjector,
  drawGrid,
  drawAxes,
  drawArrow,
  usePrefersDark,
} from '../player/canvasKit'
import type { Bounds } from '../player/canvasKit'
import './poseEditor.css'

export interface PoseEditorProps {
  input: ProblemInput
  onAddPoint: (p: Vec2) => void
  onRemoveLast: () => void
  onClear: () => void
  onUndo: () => void
  onRedo: () => void
  canUndo: boolean
  canRedo: boolean
}

function normalizeVec(v: Vec2): Vec2 {
  const len = Math.hypot(v[0], v[1])
  if (len < 1e-9) return [0, 0]
  return [v[0] / len, v[1] / len]
}

function screenDir(v: Vec2): Vec2 {
  return normalizeVec([v[0], -v[1]])
}

function extendToBorder(
  sx: number,
  sy: number,
  dx: number,
  dy: number,
  width: number,
  height: number,
): [number, number] {
  let t = Infinity
  if (dx > 1e-9) t = Math.min(t, (width - sx) / dx)
  else if (dx < -1e-9) t = Math.min(t, -sx / dx)
  if (dy > 1e-9) t = Math.min(t, (height - sy) / dy)
  else if (dy < -1e-9) t = Math.min(t, -sy / dy)
  if (!Number.isFinite(t) || t <= 0) return [sx, sy]
  return [sx + dx * t, sy + dy * t]
}

function drawPose(
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  pts: Vec2[],
  bounds: Bounds,
  theme: Theme,
  startDir: Vec2,
  endDir: Vec2,
  drawnCount: number,
  ghost: Vec2 | null,
) {
  ctx.fillStyle = theme.bg
  ctx.fillRect(0, 0, width, height)

  const project = makeProjector(bounds, width, height)
  drawGrid(ctx, project, width, height, theme)
  drawAxes(ctx, project, width, height, theme)

  if (pts.length < 2) return
  const screen: [number, number][] = pts.map(([x, y]) => [
    project.toX(x),
    project.toY(y),
  ])
  const startScreen = screen[0]
  const endScreen = screen[screen.length - 1]

  const d0 = screenDir(startDir)
  const endOut = screenDir(endDir)
  const d1: Vec2 = [-endOut[0], -endOut[1]]
  const hasD0 = d0[0] !== 0 || d0[1] !== 0
  const hasD1 = d1[0] !== 0 || d1[1] !== 0

  ctx.save()
  ctx.strokeStyle = theme.orient
  ctx.lineWidth = 1.6
  ctx.setLineDash([6, 5])
  if (hasD0) {
    const [ex, ey] = extendToBorder(
      startScreen[0],
      startScreen[1],
      d0[0],
      d0[1],
      width,
      height,
    )
    ctx.beginPath()
    ctx.moveTo(startScreen[0], startScreen[1])
    ctx.lineTo(ex, ey)
    ctx.stroke()
  }
  if (hasD1) {
    const [ex, ey] = extendToBorder(
      endScreen[0],
      endScreen[1],
      d1[0],
      d1[1],
      width,
      height,
    )
    ctx.beginPath()
    ctx.moveTo(endScreen[0], endScreen[1])
    ctx.lineTo(ex, ey)
    ctx.stroke()
  }
  ctx.restore()

  const shaft = 30
  if (hasD0) {
    drawArrow(
      ctx,
      startScreen[0],
      startScreen[1],
      startScreen[0] + d0[0] * shaft,
      startScreen[1] + d0[1] * shaft,
      theme.orient,
    )
  }
  if (hasD1) {
    drawArrow(
      ctx,
      endScreen[0],
      endScreen[1],
      endScreen[0] + d1[0] * shaft,
      endScreen[1] + d1[1] * shaft,
      theme.orient,
    )
  }

  ctx.strokeStyle = theme.chain
  ctx.lineWidth = 2.4
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(screen[0][0], screen[0][1])
  for (let i = 1; i < screen.length; i += 1) {
    ctx.lineTo(screen[i][0], screen[i][1])
  }
  ctx.stroke()

  ctx.fillStyle = theme.point
  ctx.strokeStyle = theme.pointRing
  ctx.lineWidth = 1.6
  for (let i = 1; i <= drawnCount && i < screen.length - 1; i += 1) {
    ctx.beginPath()
    ctx.arc(screen[i][0], screen[i][1], 4.4, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
  }

  ctx.save()
  ctx.globalAlpha = 0.4
  ctx.fillStyle = theme.point
  ctx.strokeStyle = theme.pointRing
  ctx.lineWidth = 1.2
  for (let i = drawnCount + 1; i < screen.length - 1; i += 1) {
    ctx.beginPath()
    ctx.arc(screen[i][0], screen[i][1], 2.8, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
  }
  ctx.restore()

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

  const drawEndpoint = (p: [number, number], color: string) => {
    const size = 12
    ctx.fillStyle = color
    ctx.strokeStyle = theme.pointRing
    ctx.lineWidth = 2
    ctx.beginPath()
    ctx.rect(p[0] - size / 2, p[1] - size / 2, size, size)
    ctx.fill()
    ctx.stroke()
  }
  drawEndpoint(endScreen, theme.end)
  drawEndpoint(startScreen, theme.start)
}

function UndoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 7v6h6"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M21 17a9 9 0 0 0-9-9H3"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function RedoIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M21 7v6h-6"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M3 17a9 9 0 0 1 9-9h9"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
    </svg>
  )
}

function TrashIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" aria-hidden="true">
      <path
        d="M3 6h18M8 6V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v2m3 0-1 14a2 2 0 0 1-2 2H8a2 2 0 0 1-2-2L5 6"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
        strokeLinejoin="round"
      />
      <path
        d="M10 11v6M14 11v6"
        stroke="currentColor"
        strokeWidth="1.9"
        strokeLinecap="round"
      />
    </svg>
  )
}

export function PoseEditor({
  input,
  onAddPoint,
  onRemoveLast,
  onClear,
  onUndo,
  onRedo,
  canUndo,
  canRedo,
}: PoseEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const [ghost, setGhost] = useState<Vec2 | null>(null)
  const dark = usePrefersDark()
  const theme = dark ? DARK_THEME : LIGHT_THEME

  const pose = useMemo(() => previewPose(input), [input])
  const bounds = useMemo(() => computePtsBounds(pose), [pose])
  const drawnPts = input.drawnPts ?? []
  const drawnCount = Math.min(drawnPts.length, input.n)
  const canAdd = drawnCount < input.n

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
    drawPose(
      ctx,
      size.width,
      size.height,
      pose,
      bounds,
      theme,
      input.startDir,
      input.endDir,
      drawnCount,
      canAdd ? ghost : null,
    )
  }, [
    pose,
    bounds,
    size,
    theme,
    input.startDir,
    input.endDir,
    drawnCount,
    canAdd,
    ghost,
  ])

  const screenToWorld = (px: number, py: number): Vec2 | null => {
    if (size.width <= 0 || size.height <= 0) return null
    const project = makeProjector(bounds, size.width, size.height)
    return [
      project.cx + (px - size.width / 2) / project.scale,
      project.cy - (py - size.height / 2) / project.scale,
    ]
  }

  const localPoint = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    if (!canvas) return null
    const rect = canvas.getBoundingClientRect()
    return { x: event.clientX - rect.left, y: event.clientY - rect.top }
  }

  const handleClick = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    if (!canAdd) return
    const point = localPoint(event)
    if (!point) return
    const world = screenToWorld(point.x, point.y)
    if (!world) return
    onAddPoint(world)
  }

  const handleMove = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    const point = localPoint(event)
    if (!point) return
    setGhost(screenToWorld(point.x, point.y))
  }

  const handleContextMenu = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    event.preventDefault()
    onRemoveLast()
  }

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      const target = event.target as HTMLElement | null
      const tag = target?.tagName
      if (
        tag === 'INPUT' ||
        tag === 'TEXTAREA' ||
        tag === 'SELECT' ||
        target?.isContentEditable
      ) {
        return
      }
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
        onRemoveLast()
      }
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [onRemoveLast, onUndo, onRedo])

  return (
    <div className="pose-editor">
      <div className="pose-editor__head">
        <h2 className="pose-editor__title">Draw the initial pose</h2>
        <span className="pose-editor__counter">
          {drawnCount} / {input.n} points placed
        </span>
      </div>
      <p className="pose-editor__hint">
        Click to place interior points; right-click or Backspace to remove the
        last; Ctrl+Z / Ctrl+Shift+Z to undo / redo.
      </p>
      <div className="pose-editor__canvas" ref={containerRef}>
        <canvas
          ref={canvasRef}
          role="img"
          aria-label="Setup editor canvas: click to place interior chain points"
          onClick={handleClick}
          onContextMenu={handleContextMenu}
          onMouseMove={handleMove}
          onMouseLeave={() => setGhost(null)}
        />
      </div>
      <div className="pose-editor__bar">
        <button
          type="button"
          className="btn btn--sm pose-editor__action"
          data-action="undo"
          aria-label="Undo point"
          title="Undo (Ctrl+Z)"
          disabled={!canUndo}
          onClick={onUndo}
        >
          <UndoIcon />
          Undo
        </button>
        <button
          type="button"
          className="btn btn--sm pose-editor__action"
          data-action="redo"
          aria-label="Redo point"
          title="Redo (Ctrl+Shift+Z)"
          disabled={!canRedo}
          onClick={onRedo}
        >
          <RedoIcon />
          Redo
        </button>
        <button
          type="button"
          className="btn btn--sm pose-editor__action"
          data-action="clear"
          aria-label="Clear points"
          title="Clear all points"
          disabled={drawnCount === 0}
          onClick={onClear}
        >
          <TrashIcon />
          Clear
        </button>
      </div>
    </div>
  )
}

export default PoseEditor
