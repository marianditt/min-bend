import { useEffect, useMemo, useRef, useState } from 'react'
import type { FrameSet } from '../solver/types'
import { boundsForScale, fitScale, nextDisplayedScale, type Bounds, type EasePhase } from './scaleEase'
import { type Theme, LIGHT_THEME, DARK_THEME, computePtsBounds, makeProjector, drawGrid, drawAxes, drawArrow, usePrefersDark } from './canvasKit'

export interface FrameCanvasProps {
  frameSet: FrameSet
  frameIndex: number
  playing: boolean
}



function draw(frameSet: FrameSet, frameIndex: number, ctx: CanvasRenderingContext2D, width: number, height: number, bounds: Bounds, theme: Theme) {
  ctx.fillStyle = theme.bg
  ctx.fillRect(0, 0, width, height)

  const project = makeProjector(bounds, width, height)
  drawGrid(ctx, project, width, height, theme)
  drawAxes(ctx, project, width, height, theme)

  const { frames } = frameSet
  if (frames.length === 0) return
  const index = Math.min(Math.max(frameIndex, 0), frames.length - 1)
  const pts = frames[index].pts
  if (pts.length === 0) return

  const screen: [number, number][] = pts.map(([x, y]) => [project.toX(x), project.toY(y)])

  // Chain polyline.
  if (screen.length >= 2) {
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
  }

  // Interior point markers.
  const last = screen.length - 1
  ctx.fillStyle = theme.point
  ctx.strokeStyle = theme.pointRing
  ctx.lineWidth = 1.4
  for (let i = 1; i < last; i += 1) {
    ctx.beginPath()
    ctx.arc(screen[i][0], screen[i][1], 3.4, 0, Math.PI * 2)
    ctx.fill()
    ctx.stroke()
  }

  // Orientation constraint arrows, from the first/last segment of frame 0.
  const first = screen[0]
  const second = screen[1]
  if (second) {
    const dx = second[0] - first[0]
    const dy = second[1] - first[1]
    const len = Math.hypot(dx, dy)
    if (len > 1e-6) {
      const shaft = Math.min(34, len * 0.85)
      drawArrow(ctx, first[0], first[1], first[0] + (dx / len) * shaft, first[1] + (dy / len) * shaft, theme.orient)
    }
  }
  const lastPt = screen[last]
  const prevPt = screen[last - 1]
  if (lastPt && prevPt) {
    const dx = lastPt[0] - prevPt[0]
    const dy = lastPt[1] - prevPt[1]
    const len = Math.hypot(dx, dy)
    if (len > 1e-6) {
      const shaft = Math.min(34, len * 0.85)
      drawArrow(ctx, lastPt[0], lastPt[1], lastPt[0] + (dx / len) * shaft, lastPt[1] + (dy / len) * shaft, theme.orient)
    }
  }

  // Fixed endpoints: larger squares, drawn last so they stay legible.
  const drawEndpoint = (p: [number, number], color: string) => {
    const size = 12
    ctx.fillStyle = color
    ctx.strokeStyle = theme.pointRing
    ctx.lineWidth = 2
    const x = p[0] - size / 2
    const y = p[1] - size / 2
    ctx.beginPath()
    ctx.rect(x, y, size, size)
    ctx.fill()
    ctx.stroke()
  }
  if (lastPt) drawEndpoint(lastPt, theme.end)
  drawEndpoint(first, theme.start)
}

export function FrameCanvas({ frameSet, frameIndex, playing }: FrameCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const dark = usePrefersDark()

  const displayedScaleRef = useRef(0)
  const phaseRef = useRef<EasePhase | null>(null)

  const clampedIndex = Math.min(Math.max(frameIndex, 0), Math.max(frameSet.frames.length - 1, 0))
  const framePts = frameSet.frames[clampedIndex]?.pts
  const bounds = useMemo(() => computePtsBounds(framePts ?? []), [framePts])
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
    draw(frameSet, frameIndex, ctx, size.width, size.height, drawBounds, theme)
    canvas.dataset.scale = String(result.scale)
  }, [frameSet, frameIndex, size, bounds, theme, playing, clampedIndex])

  return (
    <div className="frame-canvas" ref={containerRef}>
      <canvas ref={canvasRef} />
    </div>
  )
}

export default FrameCanvas
