import { useEffect, useMemo, useRef, useState } from 'react'
import { computeSegments } from '../solver/forces'
import type { Frame, FrameSet, Vec2 } from '../solver/types'
import { usePrefersDark } from './canvasKit'

export interface SegmentPlotProps {
  frameSet: FrameSet
  frameIndex: number
}

interface PlotTheme {
  grid: string
  axis: string
  length: string
  bend: string
  label: string
}

const LIGHT_THEME: PlotTheme = {
  grid: 'rgba(20, 25, 35, 0.07)',
  axis: 'rgba(20, 25, 35, 0.16)',
  length: '#3563e9',
  bend: '#b45309',
  label: '#5a6472',
}

const DARK_THEME: PlotTheme = {
  grid: 'rgba(255, 255, 255, 0.07)',
  axis: 'rgba(255, 255, 255, 0.16)',
  length: '#7aa2ff',
  bend: '#fbbf24',
  label: '#99a2b1',
}

const MIN_VEC = 1e-6
const PAD = { left: 10, right: 10, top: 16, bottom: 14 }

interface FrameProfile {
  lengths: number[]
  bends: number[]
}

/**
 * Per-segment length and absolute turn angle (degrees). bend[0] has no
 * predecessor segment and is defined as 0; degenerate vectors contribute 0.
 */
function analyzeFrame(pts: Vec2[]): FrameProfile {
  const { segments, lengths } = computeSegments(pts)
  const bends = new Array<number>(segments.length).fill(0)
  for (let k = 1; k < segments.length; k += 1) {
    const a = segments[k - 1]
    const b = segments[k]
    if (Math.hypot(a[0], a[1]) < MIN_VEC || Math.hypot(b[0], b[1]) < MIN_VEC) continue
    const cross = a[0] * b[1] - a[1] * b[0]
    const dot = a[0] * b[0] + a[1] * b[1]
    bends[k] = Math.abs(Math.atan2(cross, dot)) * (180 / Math.PI)
  }
  return { lengths, bends }
}

interface SeriesMaxima {
  length: number
  bend: number
}

/**
 * Two independent vertical scales fixed once per run so the curves never
 * jitter while animating. The initial frames carry the jagged startup spike,
 * so they are always scanned; the tail is strided to bound cost on long runs
 * (sampling is safe because length/bend vary smoothly after startup).
 */
function scanMaxima(frames: Frame[]): SeriesMaxima {
  const maxima: SeriesMaxima = { length: 0, bend: 0 }
  const total = frames.length
  if (total === 0) return maxima
  const head = Math.min(total, 60)
  const stride = Math.max(1, Math.ceil((total - head) / 1500))
  for (let i = 0; i < total; i += 1) {
    if (i >= head && (i - head) % stride !== 0) continue
    const { lengths, bends } = analyzeFrame(frames[i].pts)
    for (const value of lengths) if (value > maxima.length) maxima.length = value
    for (const value of bends) if (value > maxima.bend) maxima.bend = value
  }
  return maxima
}

function drawLegend(ctx: CanvasRenderingContext2D, theme: PlotTheme) {
  const items = [
    { label: 'length', color: theme.length },
    { label: 'bend', color: theme.bend },
  ]
  ctx.font = '10px ui-sans-serif, system-ui, sans-serif'
  ctx.textBaseline = 'middle'
  ctx.textAlign = 'left'
  let x = PAD.left
  const y = PAD.top / 2
  for (const item of items) {
    ctx.fillStyle = item.color
    ctx.fillRect(x, y - 4, 8, 8)
    x += 12
    ctx.fillStyle = theme.label
    ctx.fillText(item.label, x, y)
    x += ctx.measureText(item.label).width + 14
  }
}

function draw(
  frames: Frame[],
  frameIndex: number,
  maxima: SeriesMaxima,
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  theme: PlotTheme,
) {
  ctx.clearRect(0, 0, width, height)
  const plotW = Math.max(width - PAD.left - PAD.right, 1)
  const plotH = Math.max(height - PAD.top - PAD.bottom, 1)
  const baselineY = PAD.top + plotH

  ctx.strokeStyle = theme.grid
  ctx.lineWidth = 1
  ctx.beginPath()
  for (const frac of [1 / 3, 2 / 3]) {
    const y = Math.round(PAD.top + plotH * frac) + 0.5
    ctx.moveTo(PAD.left, y)
    ctx.lineTo(PAD.left + plotW, y)
  }
  ctx.stroke()

  ctx.strokeStyle = theme.axis
  ctx.beginPath()
  ctx.moveTo(PAD.left, Math.round(baselineY) + 0.5)
  ctx.lineTo(PAD.left + plotW, Math.round(baselineY) + 0.5)
  ctx.stroke()

  drawLegend(ctx, theme)

  const pts = frames[frameIndex]?.pts
  if (!pts || pts.length < 2) return

  const { lengths, bends } = analyzeFrame(pts)
  const count = lengths.length
  if (count === 0) return
  const denom = Math.max(count - 1, 1)
  const xFor = (k: number) => PAD.left + (k / denom) * plotW
  const yFor = (value: number, max: number) => baselineY - (value / max) * plotH

  const series = [
    { values: lengths, max: maxima.length > 0 ? maxima.length : 1, color: theme.length },
    { values: bends, max: maxima.bend > 0 ? maxima.bend : 1, color: theme.bend },
  ]

  if (count === 1) {
    for (const item of series) {
      ctx.fillStyle = item.color
      ctx.beginPath()
      ctx.arc(xFor(0), yFor(item.values[0], item.max), 2.2, 0, Math.PI * 2)
      ctx.fill()
    }
    return
  }

  ctx.lineWidth = 1.8
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  for (const item of series) {
    ctx.strokeStyle = item.color
    ctx.beginPath()
    ctx.moveTo(xFor(0), yFor(item.values[0], item.max))
    for (let k = 1; k < item.values.length; k += 1) {
      ctx.lineTo(xFor(k), yFor(item.values[k], item.max))
    }
    ctx.stroke()
  }
}

export function SegmentPlot({ frameSet, frameIndex }: SegmentPlotProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const dark = usePrefersDark()
  const theme = dark ? DARK_THEME : LIGHT_THEME
  const maxima = useMemo(() => scanMaxima(frameSet.frames), [frameSet])

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
    draw(frameSet.frames, frameIndex, maxima, ctx, size.width, size.height, theme)
  }, [frameSet, frameIndex, size, maxima, theme])

  return (
    <div className="segment-plot" ref={containerRef}>
      <canvas ref={canvasRef} />
    </div>
  )
}

export default SegmentPlot
