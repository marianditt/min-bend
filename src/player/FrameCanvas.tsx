import { useEffect, useMemo, useRef, useState } from 'react'
import type { Curve, FrameSet } from '../solver/types'
import { fixIndices } from '../solver/curve'
import { boundsForScale, fitScale, nextDisplayedScale, type Bounds, type EasePhase } from './scaleEase'
import {
  type Theme,
  LIGHT_THEME,
  DARK_THEME,
  computePtsBounds,
  makeProjector,
  drawGrid,
  drawAxes,
  drawArrow,
  curveColor,
  usePrefersDark,
} from './canvasKit'

export interface FrameCanvasProps {
  frameSet: FrameSet
  frameIndex: number
  playing: boolean
}

const EMPTY_CURVE: Curve = { fixPoints: [], n: 0, spans: [] }

function draw(
  frameSet: FrameSet,
  frameIndex: number,
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  bounds: Bounds,
  theme: Theme,
  dark: boolean,
) {
  ctx.fillStyle = theme.bg
  ctx.fillRect(0, 0, width, height)

  const project = makeProjector(bounds, width, height)
  drawGrid(ctx, project, width, height, theme)
  drawAxes(ctx, project, width, height, theme)

  const { frames } = frameSet
  if (frames.length === 0) return
  const index = Math.min(Math.max(frameIndex, 0), frames.length - 1)
  const curves = frames[index].curves
  const inputCurves = frameSet.meta.input?.curves ?? []

  curves.forEach((pts, ci) => {
    if (!pts || pts.length === 0) return
    if (inputCurves[ci]?.hidden) return
    const color = curveColor(ci, dark)
    const screen: [number, number][] = pts.map(([x, y]) => [project.toX(x), project.toY(y)])
    const curve = inputCurves[ci] ?? EMPTY_CURVE
    const fix = fixIndices(curve)
    const fixSet = new Set(fix)

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

    ctx.fillStyle = color
    ctx.strokeStyle = theme.pointRing
    ctx.lineWidth = 1.4
    for (let i = 1; i < screen.length - 1; i += 1) {
      if (fixSet.has(i)) continue
      ctx.beginPath()
      ctx.arc(screen[i][0], screen[i][1], 3.4, 0, Math.PI * 2)
      ctx.fill()
      ctx.stroke()
    }

    curve.fixPoints.forEach((fp, pi) => {
      if (!fp.orientation) return
      const p = screen[fix[pi]]
      if (!p) return
      const len = Math.hypot(fp.orientation[0], fp.orientation[1])
      if (len < 1e-9) return
      const ux = fp.orientation[0] / len
      const uy = fp.orientation[1] / len
      drawArrow(ctx, p[0], p[1], p[0] + ux * 30, p[1] - uy * 30, theme.orient)
    })

    const drawEndpoint = (p: [number, number], endpointColor: string) => {
      const size = 12
      ctx.fillStyle = endpointColor
      ctx.strokeStyle = theme.pointRing
      ctx.lineWidth = 2
      ctx.beginPath()
      ctx.rect(p[0] - size / 2, p[1] - size / 2, size, size)
      ctx.fill()
      ctx.stroke()
    }
    const lastPi = curve.fixPoints.length - 1
    curve.fixPoints.forEach((_, pi) => {
      const p = screen[fix[pi]]
      if (!p) return
      if (pi === 0) drawEndpoint(p, theme.start)
      else if (pi === lastPi) drawEndpoint(p, theme.end)
      else drawEndpoint(p, theme.orient)
    })
  })
}

export function FrameCanvas({ frameSet, frameIndex, playing }: FrameCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const dark = usePrefersDark()

  const displayedScaleRef = useRef(0)
  const phaseRef = useRef<EasePhase | null>(null)

  const clampedIndex = Math.min(Math.max(frameIndex, 0), Math.max(frameSet.frames.length - 1, 0))
  const frameCurves = frameSet.frames[clampedIndex]?.curves
  const inputCurves = frameSet.meta.input?.curves
  const bounds = useMemo(() => {
    const curves = frameCurves ?? []
    const visible = inputCurves ? curves.filter((_, ci) => !inputCurves[ci]?.hidden) : curves
    return computePtsBounds(visible.flat())
  }, [frameCurves, inputCurves])
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
    draw(frameSet, frameIndex, ctx, size.width, size.height, drawBounds, theme, dark)
    canvas.dataset.scale = String(result.scale)
  }, [frameSet, frameIndex, size, bounds, theme, playing, clampedIndex, dark])

  return (
    <div className="frame-canvas" ref={containerRef}>
      <canvas ref={canvasRef} />
    </div>
  )
}

export default FrameCanvas
