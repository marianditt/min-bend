import { useEffect, useMemo, useRef, useState } from 'react'
import type { Frame, FrameSet } from '../solver/types'
import { curveColor, usePrefersDark } from './canvasKit'
import { PLOT_DARK, PLOT_LIGHT } from './plotTheme'

export interface CoordinatePlotProps {
  frameSet: FrameSet
  frameIndex: number
  axis: 0 | 1
}

interface PlotTheme {
  grid: string
  axis: string
  zero: string
  label: string
  bg: string
}

const LIGHT_THEME: PlotTheme = { ...PLOT_LIGHT, zero: 'rgba(20, 25, 35, 0.4)' }

const DARK_THEME: PlotTheme = { ...PLOT_DARK, zero: 'rgba(255, 255, 255, 0.4)' }

const PAD = { left: 10, right: 10, top: 14, bottom: 14 }

interface Range {
  min: number
  max: number
}

function scanRange(frames: Frame[], axis: 0 | 1, hidden: boolean[]): Range {
  let min = Infinity
  let max = -Infinity
  const total = frames.length
  if (total === 0) return { min: 0, max: 1 }
  const head = Math.min(total, 60)
  const stride = Math.max(1, Math.ceil((total - head) / 1500))
  for (let i = 0; i < total; i += 1) {
    if (i >= head && (i - head) % stride !== 0) continue
    frames[i].curves.forEach((curve, ci) => {
      if (hidden[ci]) return
      for (const p of curve) {
        const v = p[axis]
        if (v < min) min = v
        if (v > max) max = v
      }
    })
  }
  if (!Number.isFinite(min) || !Number.isFinite(max)) return { min: 0, max: 1 }
  if (max - min < 1e-9) {
    return { min: min - 0.5, max: max + 0.5 }
  }
  return { min, max }
}

function draw(
  frames: Frame[],
  frameIndex: number,
  axis: 0 | 1,
  range: Range,
  ctx: CanvasRenderingContext2D,
  width: number,
  height: number,
  theme: PlotTheme,
  dark: boolean,
  hidden: boolean[],
) {
  ctx.fillStyle = theme.bg
  ctx.fillRect(0, 0, width, height)
  const plotW = Math.max(width - PAD.left - PAD.right, 1)
  const plotH = Math.max(height - PAD.top - PAD.bottom, 1)

  ctx.strokeStyle = theme.grid
  ctx.lineWidth = 1
  ctx.beginPath()
  for (const frac of [1 / 3, 2 / 3]) {
    const y = Math.round(PAD.top + plotH * frac) + 0.5
    ctx.moveTo(PAD.left, y)
    ctx.lineTo(PAD.left + plotW, y)
  }
  ctx.stroke()

  const yFor = (v: number) => PAD.top + plotH - ((v - range.min) / (range.max - range.min)) * plotH

  ctx.strokeStyle = theme.zero
  ctx.lineWidth = 1
  ctx.beginPath()
  const zeroY = Math.round(yFor(0)) + 0.5
  ctx.moveTo(PAD.left, zeroY)
  ctx.lineTo(PAD.left + plotW, zeroY)
  ctx.stroke()

  ctx.font = '10px ui-sans-serif, system-ui, sans-serif'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  ctx.fillStyle = theme.label
  ctx.fillText(axis === 0 ? 'x(k)' : 'y(k)', PAD.left, PAD.top)

  const frame = frames[frameIndex]
  if (!frame) return
  frame.curves.forEach((pts, ci) => {
    if (hidden[ci]) return
    if (pts.length < 2) return
    const count = pts.length
    const denom = Math.max(count - 1, 1)
    ctx.strokeStyle = curveColor(ci, dark)
    ctx.lineWidth = 1.8
    ctx.lineJoin = 'round'
    ctx.lineCap = 'round'
    ctx.beginPath()
    pts.forEach((p, k) => {
      const x = PAD.left + (k / denom) * plotW
      const y = yFor(p[axis])
      if (k === 0) ctx.moveTo(x, y)
      else ctx.lineTo(x, y)
    })
    ctx.stroke()
  })
}

export function CoordinatePlot({ frameSet, frameIndex, axis }: CoordinatePlotProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [size, setSize] = useState({ width: 0, height: 0 })
  const dark = usePrefersDark()
  const theme = dark ? DARK_THEME : LIGHT_THEME
  const hidden = useMemo(
    () => (frameSet.meta.input?.curves ?? []).map((c) => !!c.hidden),
    [frameSet],
  )
  const range = useMemo(() => scanRange(frameSet.frames, axis, hidden), [frameSet, axis, hidden])

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
    draw(frameSet.frames, frameIndex, axis, range, ctx, size.width, size.height, theme, dark, hidden)
  }, [frameSet, frameIndex, axis, range, size, theme, dark, hidden])

  return (
    <div className="coordinate-plot" ref={containerRef}>
      <canvas ref={canvasRef} />
    </div>
  )
}

export default CoordinatePlot
