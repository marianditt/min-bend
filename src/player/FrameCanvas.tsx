import { useEffect, useMemo, useRef, useState } from 'react'
import type { MouseEvent as ReactMouseEvent } from 'react'
import type { FrameSet, Vec2 } from '../solver/types'
import { boundsForScale, fitScale, nextDisplayedScale, type Bounds, type EasePhase } from './scaleEase'
import {
  type CurveProbe,
  type Projector,
  type Theme,
  LIGHT_THEME,
  DARK_THEME,
  closestOnCurves,
  computePtsBounds,
  makeProjector,
  drawGrid,
  drawAxes,
  drawArrow,
  drawControlPoint,
  drawInteriorPoint,
  curveColor,
  readProbe,
  usePrefersDark,
} from './canvasKit'

export interface FrameCanvasProps {
  frameSet: FrameSet
  frameIndex: number
  playing: boolean
  hidden: boolean[]
  probe: CurveProbe | null
  onProbe: (probe: CurveProbe | null) => void
}

function draw(
  frameSet: FrameSet,
  frameIndex: number,
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  bounds: Bounds,
  theme: Theme,
  dark: boolean,
  hidden: boolean[],
  probe: CurveProbe | null,
): Projector {
  ctx.fillStyle = theme.bg
  ctx.fillRect(0, 0, width, height)

  const project = makeProjector(bounds, width, height)
  drawGrid(ctx, project, width, height, theme)
  drawAxes(ctx, project, width, height, theme)

  const { frames } = frameSet
  if (frames.length === 0) return project
  const index = Math.min(Math.max(frameIndex, 0), frames.length - 1)
  const curves = frames[index].curves
  const inputCurves = frameSet.meta.input?.curves ?? []

  curves.forEach((pts, ci) => {
    if (!pts || pts.length === 0) return
    if (hidden[ci]) return
    const color = curveColor(ci, dark)
    const screen: [number, number][] = pts.map(([x, y]) => [project.toX(x), project.toY(y)])
    const curve = inputCurves[ci]
    const control = frames[index].controlIndices?.[ci] ?? []
    const controlSet = new Set(control)

    if (screen.length >= 2) {
      ctx.strokeStyle = color
      ctx.lineWidth = 2.4
      ctx.lineJoin = 'round'
      ctx.lineCap = 'round'
      ctx.beginPath()
      ctx.moveTo(screen[0][0], screen[0][1])
      for (let i = 1; i < screen.length; i += 1) ctx.lineTo(screen[i][0], screen[i][1])
      ctx.stroke()
    }

    for (let i = 0; i < screen.length; i += 1) {
      if (!controlSet.has(i)) drawInteriorPoint(ctx, screen[i][0], screen[i][1], theme)
    }

    curve?.fixPoints.forEach((fp, pi) => {
      const p = screen[control[pi]]
      if (!p) return
      if (fp.orientation) {
        const len = Math.hypot(fp.orientation[0], fp.orientation[1])
        if (len >= 1e-9) {
          const ux = fp.orientation[0] / len
          const uy = fp.orientation[1] / len
          drawArrow(ctx, p[0], p[1], p[0] + ux * 30, p[1] - uy * 30, theme.orient)
        }
      }
    })
    curve?.fixPoints.forEach((fp, pi) => {
      const p = screen[control[pi]]
      if (p) drawControlPoint(ctx, p[0], p[1], fp.posFree === true, theme)
    })
  })

  if (probe && !hidden[probe.curve]) {
    const reading = readProbe(curves[probe.curve], probe)
    if (reading) {
      const x = project.toX(reading.point[0])
      const y = project.toY(reading.point[1])
      drawArrow(
        ctx,
        x,
        y,
        x + reading.tangent[0] * 48,
        y - reading.tangent[1] * 48,
        theme.probe,
      )
      ctx.strokeStyle = theme.probe
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.arc(x, y, 7, 0, Math.PI * 2)
      ctx.stroke()
    }
  }
  return project
}

export function FrameCanvas({ frameSet, frameIndex, playing, hidden, probe, onProbe }: FrameCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const dark = usePrefersDark()

  const displayedScaleRef = useRef(0)
  const phaseRef = useRef<EasePhase | null>(null)
  const projectorRef = useRef<Projector | null>(null)

  const clampedIndex = Math.min(Math.max(frameIndex, 0), Math.max(frameSet.frames.length - 1, 0))
  const frameCurves = frameSet.frames[clampedIndex]?.curves
  const bounds = useMemo(() => {
    const curves = frameCurves ?? []
    const visible = curves.filter((_, ci) => !hidden[ci])
    return computePtsBounds(visible.flat())
  }, [frameCurves, hidden])
  const theme = dark ? DARK_THEME : LIGHT_THEME

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
    const target = fitScale(bounds, size.width, size.height)
    const previous = displayedScaleRef.current === 0 ? target : displayedScaleRef.current
    const result = nextDisplayedScale({
      previous,
      target,
      phase: phaseRef.current,
      frameIndex: clampedIndex,
      totalFrames: frameSet.frames.length,
      easingEnabled: playing,
    })
    displayedScaleRef.current = result.scale
    phaseRef.current = result.phase
    const drawBounds = result.scale === target ? bounds : boundsForScale(bounds, target, result.scale)
    projectorRef.current = draw(frameSet, frameIndex, ctx, size.width, size.height, drawBounds, theme, dark, hidden, probe)
    canvas.dataset.scale = String(result.scale)
  }, [frameSet, frameIndex, size, bounds, theme, playing, clampedIndex, dark, hidden, probe])

  const handleClick = (event: ReactMouseEvent<HTMLCanvasElement>) => {
    const canvas = canvasRef.current
    const project = projectorRef.current
    if (!canvas || !project) return
    const rect = canvas.getBoundingClientRect()
    const sx = event.clientX - rect.left
    const sy = event.clientY - rect.top
    const world: Vec2 = [
      project.cx + (sx - size.width / 2) / project.scale,
      project.cy - (sy - size.height / 2) / project.scale,
    ]
    const visible = (frameCurves ?? []).map((pts, ci) => (hidden[ci] ? null : pts))
    onProbe(closestOnCurves(visible, world))
  }

  return (
    <div className="frame-canvas" ref={containerRef}>
      <canvas ref={canvasRef} onClick={handleClick} title="Click to measure the tangent at the closest curve point" />
    </div>
  )
}

export default FrameCanvas
