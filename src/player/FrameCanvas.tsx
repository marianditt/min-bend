import { useEffect, useMemo, useRef, useState } from 'react'
import type { FrameSet } from '../solver/types'

export interface FrameCanvasProps {
  frameSet: FrameSet
  frameIndex: number
}

interface Bounds {
  minX: number
  minY: number
  maxX: number
  maxY: number
}

interface Theme {
  bg: string
  grid: string
  chain: string
  point: string
  pointRing: string
  start: string
  end: string
  orient: string
}

const LIGHT_THEME: Theme = {
  bg: '#f8f9fb',
  grid: 'rgba(20, 25, 35, 0.055)',
  chain: '#1f2530',
  point: '#3563e9',
  pointRing: 'rgba(255, 255, 255, 0.95)',
  start: '#128a43',
  end: '#cf2e2e',
  orient: '#b45309',
}

const DARK_THEME: Theme = {
  bg: '#0b0d11',
  grid: 'rgba(255, 255, 255, 0.05)',
  chain: '#e6e9ef',
  point: '#7aa2ff',
  pointRing: 'rgba(11, 13, 17, 0.95)',
  start: '#4ade80',
  end: '#f87272',
  orient: '#fbbf24',
}

/** Union bounding box of every point across every frame (stable view). */
function computeBounds(frameSet: FrameSet): Bounds {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const frame of frameSet.frames) {
    for (const [x, y] of frame.pts) {
      if (x < minX) minX = x
      if (y < minY) minY = y
      if (x > maxX) maxX = x
      if (y > maxY) maxY = y
    }
  }
  if (!Number.isFinite(minX)) {
    return { minX: -1, minY: -1, maxX: 1, maxY: 1 }
  }
  return { minX, minY, maxX, maxY }
}

interface Projector {
  toX: (x: number) => number
  toY: (y: number) => number
}

/** Equal-scale, centered fit of the bounds into the canvas with padding. */
function makeProjector(
  bounds: Bounds,
  width: number,
  height: number,
): Projector {
  const pad = Math.max(22, Math.min(width, height) * 0.09)
  const availW = Math.max(width - 2 * pad, 1)
  const availH = Math.max(height - 2 * pad, 1)
  const spanX = Math.max(bounds.maxX - bounds.minX, 1e-9)
  const spanY = Math.max(bounds.maxY - bounds.minY, 1e-9)
  const scale = Math.min(availW / spanX, availH / spanY)
  const cx = (bounds.minX + bounds.maxX) / 2
  const cy = (bounds.minY + bounds.maxY) / 2
  return {
    toX: (x) => width / 2 + (x - cx) * scale,
    toY: (y) => height / 2 - (y - cy) * scale,
  }
}

function drawGrid(ctx: CanvasRenderingContext2D, width: number, height: number, theme: Theme) {
  const spacing = 32
  ctx.strokeStyle = theme.grid
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let x = spacing; x < width; x += spacing) {
    ctx.moveTo(Math.round(x) + 0.5, 0)
    ctx.lineTo(Math.round(x) + 0.5, height)
  }
  for (let y = spacing; y < height; y += spacing) {
    ctx.moveTo(0, Math.round(y) + 0.5)
    ctx.lineTo(width, Math.round(y) + 0.5)
  }
  ctx.stroke()
}

function drawArrow(
  ctx: CanvasRenderingContext2D,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  color: string,
) {
  const dx = x1 - x0
  const dy = y1 - y0
  const length = Math.hypot(dx, dy)
  if (length < 1e-6) return
  const ux = dx / length
  const uy = dy / length
  const tipX = x0 + ux * length
  const tipY = y0 + uy * length
  const head = 8

  ctx.strokeStyle = color
  ctx.fillStyle = color
  ctx.lineWidth = 2
  ctx.lineCap = 'round'
  ctx.beginPath()
  ctx.moveTo(x0, y0)
  ctx.lineTo(tipX - ux * head * 0.5, tipY - uy * head * 0.5)
  ctx.stroke()

  ctx.beginPath()
  ctx.moveTo(tipX, tipY)
  ctx.lineTo(tipX - ux * head - uy * head * 0.55, tipY - uy * head + ux * head * 0.55)
  ctx.lineTo(tipX - ux * head + uy * head * 0.55, tipY - uy * head - ux * head * 0.55)
  ctx.closePath()
  ctx.fill()
}

function draw(frameSet: FrameSet, frameIndex: number, ctx: CanvasRenderingContext2D, width: number, height: number, bounds: Bounds, theme: Theme) {
  ctx.fillStyle = theme.bg
  ctx.fillRect(0, 0, width, height)
  drawGrid(ctx, width, height, theme)

  const { frames } = frameSet
  if (frames.length === 0) return
  const index = Math.min(Math.max(frameIndex, 0), frames.length - 1)
  const pts = frames[index].pts
  if (pts.length === 0) return

  const project = makeProjector(bounds, width, height)
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

function usePrefersDark(): boolean {
  const [dark, setDark] = useState(
    () => typeof window !== 'undefined' && window.matchMedia('(prefers-color-scheme: dark)').matches,
  )
  useEffect(() => {
    const query = window.matchMedia('(prefers-color-scheme: dark)')
    const onChange = () => setDark(query.matches)
    query.addEventListener('change', onChange)
    return () => query.removeEventListener('change', onChange)
  }, [])
  return dark
}

export function FrameCanvas({ frameSet, frameIndex }: FrameCanvasProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const dark = usePrefersDark()

  const bounds = useMemo(() => computeBounds(frameSet), [frameSet])
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
    draw(frameSet, frameIndex, ctx, size.width, size.height, bounds, theme)
  }, [frameSet, frameIndex, size, bounds, theme])

  return (
    <div className="frame-canvas" ref={containerRef}>
      <canvas ref={canvasRef} />
    </div>
  )
}

export default FrameCanvas
