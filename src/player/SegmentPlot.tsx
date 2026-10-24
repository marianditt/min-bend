import { useEffect, useMemo, useRef, useState } from 'react'
import { computeSegments } from '../solver/forces'
import type { Frame, FrameSet, Vec2 } from '../solver/types'
import { usePrefersDark } from './canvasKit'
import { PLOT_DARK, PLOT_LIGHT } from './plotTheme'

export interface SegmentPlotProps {
  frameSet: FrameSet
  frameIndex: number
  curveIndex: number
}

interface PlotTheme {
  grid: string
  axis: string
  length: string
  bend: string
  label: string
  bg: string
}

const LIGHT_THEME: PlotTheme = { ...PLOT_LIGHT, length: '#3563e9', bend: '#b45309' }

const DARK_THEME: PlotTheme = { ...PLOT_DARK, length: '#7aa2ff', bend: '#fbbf24' }

const MIN_VEC = 1e-6
const PAD = { left: 10, right: 10, top: 16, bottom: 14 }

interface FrameProfile {
  /** Length of segment k, plotted at x = k + 0.5 (in point-index units). */
  lengths: number[]
  /**
   * Turn angle (degrees) at point k, plotted at x = k, for k = 0..segments.
   * Interior points use the angle between the adjacent segments. An end point
   * with a fixed orientation uses the angle between that orientation and its
   * only segment; a free end has no defined angle (null).
   */
  bends: (number | null)[]
}

function angleBetween(a: Vec2, b: Vec2): number | null {
  if (Math.hypot(a[0], a[1]) < MIN_VEC || Math.hypot(b[0], b[1]) < MIN_VEC) return null
  return Math.abs(Math.atan2(a[0] * b[1] - a[1] * b[0], a[0] * b[0] + a[1] * b[1])) * (180 / Math.PI)
}

function analyzeFrame(pts: Vec2[], startDir: Vec2 | null, endDir: Vec2 | null): FrameProfile {
  const { segments, lengths } = computeSegments(pts)
  const bends: (number | null)[] = new Array(segments.length + 1).fill(null)
  for (let k = 1; k < segments.length; k += 1) bends[k] = angleBetween(segments[k - 1], segments[k])
  if (segments.length > 0) {
    if (startDir) bends[0] = angleBetween(startDir, segments[0])
    if (endDir) bends[segments.length] = angleBetween(segments[segments.length - 1], endDir)
  }
  return { lengths, bends }
}

/** Fixed orientations at the two ends of a curve (null when free). */
function endDirections(frameSet: FrameSet, curveIndex: number): [Vec2 | null, Vec2 | null] {
  const fixPoints = frameSet.meta.input?.curves?.[curveIndex]?.fixPoints ?? []
  return [fixPoints[0]?.orientation ?? null, fixPoints[fixPoints.length - 1]?.orientation ?? null]
}

interface SeriesMaxima {
  length: number
  bend: number
}

interface FrameAggregates {
  avgLength: number
  maxBend: number
}

/**
 * Two independent vertical scales fixed once per run so the curves never
 * jitter while animating. The initial frames carry the jagged startup spike,
 * so they are always scanned; the tail is strided to bound cost on long runs
 * (sampling is safe because length/bend vary smoothly after startup).
 */
function scanMaxima(frames: Frame[], curveIndex: number, dirs: [Vec2 | null, Vec2 | null]): SeriesMaxima {
  const maxima: SeriesMaxima = { length: 0, bend: 0 }
  const total = frames.length
  if (total === 0) return maxima
  const head = Math.min(total, 60)
  const stride = Math.max(1, Math.ceil((total - head) / 1500))
  for (let i = 0; i < total; i += 1) {
    if (i >= head && (i - head) % stride !== 0) continue
    const { lengths, bends } = analyzeFrame(frames[i].curves[curveIndex] ?? [], dirs[0], dirs[1])
    for (const value of lengths) if (value > maxima.length) maxima.length = value
    for (const value of bends) if (value !== null && value > maxima.bend) maxima.bend = value
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

function drawGuide(
  ctx: CanvasRenderingContext2D,
  y: number,
  label: string,
  color: string,
  plotW: number,
  theme: PlotTheme,
) {
  ctx.save()
  ctx.setLineDash([4, 4])
  ctx.lineWidth = 1.2
  ctx.strokeStyle = color
  ctx.globalAlpha = 0.7
  ctx.beginPath()
  ctx.moveTo(PAD.left, Math.round(y) + 0.5)
  ctx.lineTo(PAD.left + plotW, Math.round(y) + 0.5)
  ctx.stroke()

  ctx.setLineDash([])
  ctx.globalAlpha = 1
  ctx.font = '10px ui-sans-serif, system-ui, sans-serif'
  ctx.textAlign = 'right'
  const below = y - 12 < PAD.top
  ctx.textBaseline = below ? 'top' : 'bottom'
  const tx = PAD.left + plotW
  const ty = below ? y + 2 : y - 2
  ctx.lineWidth = 3
  ctx.lineJoin = 'round'
  ctx.strokeStyle = theme.bg
  ctx.strokeText(label, tx, ty)
  ctx.fillStyle = color
  ctx.fillText(label, tx, ty)
  ctx.restore()
}

function draw(
  frames: Frame[],
  frameIndex: number,
  curveIndex: number,
  maxima: SeriesMaxima,
  dirs: [Vec2 | null, Vec2 | null],
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  theme: PlotTheme,
): FrameAggregates | null {
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

  const pts = frames[frameIndex]?.curves[curveIndex]
  if (!pts || pts.length < 2) return null

  const { lengths, bends } = analyzeFrame(pts, dirs[0], dirs[1])
  const count = lengths.length
  if (count === 0) return null
  const lenMax = maxima.length > 0 ? maxima.length : 1
  const bendMax = maxima.bend > 0 ? maxima.bend : 1
  const xFor = (position: number) => PAD.left + (position / count) * plotW
  const yFor = (value: number, max: number) => baselineY - (value / max) * plotH

  let sumLengths = 0
  for (const value of lengths) sumLengths += value
  const avgLength = sumLengths / count
  let maxBend = 0
  for (const value of bends) if (value !== null && value > maxBend) maxBend = value
  drawGuide(ctx, yFor(avgLength, lenMax), `avg length ${avgLength.toFixed(3)}`, theme.length, plotW, theme)
  drawGuide(ctx, yFor(maxBend, bendMax), `max bend ${maxBend.toFixed(1)}°`, theme.bend, plotW, theme)

  const series = [
    { values: lengths, offset: 0.5, max: lenMax, color: theme.length },
    { values: bends, offset: 0, max: bendMax, color: theme.bend },
  ]

  ctx.lineWidth = 1.8
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  for (const item of series) {
    ctx.strokeStyle = item.color
    ctx.fillStyle = item.color
    ctx.beginPath()
    let pen = false
    item.values.forEach((value, k) => {
      if (value === null) {
        pen = false
        return
      }
      const x = xFor(k + item.offset)
      const y = yFor(value, item.max)
      if (pen) ctx.lineTo(x, y)
      else ctx.moveTo(x, y)
      pen = true
    })
    ctx.stroke()
    // Isolated samples (neighbors undefined) would otherwise be invisible.
    item.values.forEach((value, k) => {
      if (value === null || item.values[k - 1] != null || item.values[k + 1] != null) return
      ctx.beginPath()
      ctx.arc(xFor(k + item.offset), yFor(value, item.max), 2.2, 0, Math.PI * 2)
      ctx.fill()
    })
  }
  return { avgLength, maxBend }
}

export function SegmentPlot({ frameSet, frameIndex, curveIndex }: SegmentPlotProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const dark = usePrefersDark()
  const theme = dark ? DARK_THEME : LIGHT_THEME
  const dirs = useMemo(() => endDirections(frameSet, curveIndex), [frameSet, curveIndex])
  const maxima = useMemo(() => scanMaxima(frameSet.frames, curveIndex, dirs), [frameSet, curveIndex, dirs])

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
    const aggregates = draw(frameSet.frames, frameIndex, curveIndex, maxima, dirs, ctx, size.width, size.height, theme)
    if (aggregates) {
      canvas.dataset.avgLength = String(aggregates.avgLength)
      canvas.dataset.maxBend = String(aggregates.maxBend)
    } else {
      delete canvas.dataset.avgLength
      delete canvas.dataset.maxBend
    }
  }, [frameSet, frameIndex, curveIndex, size, maxima, dirs, theme])

  return (
    <div className="segment-plot" ref={containerRef}>
      <canvas ref={canvasRef} />
    </div>
  )
}

export default SegmentPlot
