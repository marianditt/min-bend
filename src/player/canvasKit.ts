import type { Bounds } from './scaleEase'
import { fitPadding } from './scaleEase'
export { type Bounds, fitPadding } from './scaleEase'
import type { Vec2 } from '../solver/types'
import { useState, useEffect } from 'react'

export interface Theme {
  bg: string
  grid: string
  axis: string
  chain: string
  point: string
  pointRing: string
  orient: string
  /** Control point with a fixed position. */
  controlFixed: string
  /** Control point whose position the optimizer may change. */
  controlFree: string
  /** Outline that keeps light discs visible on the background. */
  controlRing: string
  /** Interior (free) points. */
  interior: string
  /** Tangent probe marker. */
  probe: string
}

export const LIGHT_THEME: Theme = {
  bg: '#f8f9fb',
  grid: 'rgba(20, 25, 35, 0.055)',
  axis: '#4b5563',
  chain: '#1f2530',
  point: '#3563e9',
  pointRing: 'rgba(255, 255, 255, 0.95)',
  orient: '#b45309',
  controlFixed: '#ffffff',
  controlFree: '#9ca3af',
  controlRing: '#1f2530',
  interior: '#3563e9',
  probe: '#c026d3',
}

export const DARK_THEME: Theme = {
  bg: '#0b0d11',
  grid: 'rgba(255, 255, 255, 0.05)',
  axis: '#8b95a7',
  chain: '#e6e9ef',
  point: '#7aa2ff',
  pointRing: 'rgba(11, 13, 17, 0.95)',
  orient: '#fbbf24',
  controlFixed: '#ffffff',
  controlFree: '#6b7280',
  controlRing: '#e6e9ef',
  interior: '#7aa2ff',
  probe: '#e879f9',
}

const LIGHT_CURVES = ['#3563e9', '#128a43', '#cf2e2e', '#b45309', '#7c3aed', '#0891b2']
const DARK_CURVES = ['#7aa2ff', '#4ade80', '#f87272', '#fbbf24', '#c084fc', '#22d3ee']

export function curveColor(index: number, dark: boolean): string {
  const palette = dark ? DARK_CURVES : LIGHT_CURVES
  return palette[index % palette.length]
}

export function computePtsBounds(pts: Vec2[]): Bounds {
  let minX = Infinity
  let minY = Infinity
  let maxX = -Infinity
  let maxY = -Infinity
  for (const [x, y] of pts) {
    if (x < minX) minX = x
    if (y < minY) minY = y
    if (x > maxX) maxX = x
    if (y > maxY) maxY = y
  }
  if (!Number.isFinite(minX)) {
    return { minX: -1, minY: -1, maxX: 1, maxY: 1 }
  }
  return { minX, minY, maxX, maxY }
}

export interface Projector {
  toX: (x: number) => number
  toY: (y: number) => number
  scale: number
  cx: number
  cy: number
}

/** Equal-scale, centered fit of the bounds into the canvas with padding. */
export function makeProjector(
  bounds: Bounds,
  width: number,
  height: number,
): Projector {
  const pad = fitPadding(width, height)
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
    scale,
    cx,
    cy,
  }
}

/** Round a world step to the nearest 1/2/5 * 10^k so screen spacing stays near the target. */
export function niceStep(raw: number): number {
  const exponent = Math.floor(Math.log10(raw))
  const pow = 10 ** exponent
  const frac = raw / pow
  const mantissa = frac < Math.SQRT2 ? 1 : frac < Math.sqrt(10) ? 2 : frac < Math.sqrt(50) ? 5 : 10
  return mantissa * pow
}

export function drawGrid(
  ctx: CanvasRenderingContext2D,
  project: Projector,
  width: number,
  height: number,
  theme: Theme,
) {
  const { scale, cx, cy, toX, toY } = project
  const step = niceStep(48 / scale)
  const left = cx - width / (2 * scale)
  const right = cx + width / (2 * scale)
  const bottom = cy - height / (2 * scale)
  const top = cy + height / (2 * scale)

  ctx.strokeStyle = theme.grid
  ctx.lineWidth = 1
  ctx.beginPath()
  for (let wx = Math.ceil(left / step) * step; wx <= right; wx += step) {
    const sx = Math.round(toX(wx)) + 0.5
    ctx.moveTo(sx, 0)
    ctx.lineTo(sx, height)
  }
  for (let wy = Math.ceil(bottom / step) * step; wy <= top; wy += step) {
    const sy = Math.round(toY(wy)) + 0.5
    ctx.moveTo(0, sy)
    ctx.lineTo(width, sy)
  }
  ctx.stroke()
}

/** World-origin axes (x at y=0, y at x=0), drawn over the grid and behind the chain. */
export function drawAxes(
  ctx: CanvasRenderingContext2D,
  project: Projector,
  width: number,
  height: number,
  theme: Theme,
) {
  const { scale, cx, cy, toX, toY } = project
  const left = cx - width / (2 * scale)
  const right = cx + width / (2 * scale)
  const bottom = cy - height / (2 * scale)
  const top = cy + height / (2 * scale)

  ctx.strokeStyle = theme.axis
  ctx.lineWidth = 2
  ctx.beginPath()
  if (left <= 0 && right >= 0) {
    const sx = Math.round(toX(0))
    ctx.moveTo(sx, 0)
    ctx.lineTo(sx, height)
  }
  if (bottom <= 0 && top >= 0) {
    const sy = Math.round(toY(0))
    ctx.moveTo(0, sy)
    ctx.lineTo(width, sy)
  }
  ctx.stroke()
}

export function drawArrow(
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

/** Control point: white disc when its position is fixed, gray when the optimizer may move it. */
export function drawControlPoint(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  posFree: boolean,
  theme: Theme,
) {
  ctx.fillStyle = posFree ? theme.controlFree : theme.controlFixed
  ctx.strokeStyle = theme.controlRing
  ctx.lineWidth = 1.8
  ctx.beginPath()
  ctx.arc(x, y, 6, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()
}

/** Interior point: small blue disc. */
export function drawInteriorPoint(ctx: CanvasRenderingContext2D, x: number, y: number, theme: Theme) {
  ctx.fillStyle = theme.interior
  ctx.strokeStyle = theme.pointRing
  ctx.lineWidth = 1.2
  ctx.beginPath()
  ctx.arc(x, y, 3, 0, Math.PI * 2)
  ctx.fill()
  ctx.stroke()
}

export interface CurveProbe {
  /** Curve index. */
  curve: number
  /** Segment index within the curve. */
  segment: number
  /** Position along the segment, 0..1. */
  t: number
}

export interface ProbeReading {
  point: Vec2
  /** Unit tangent along the curve direction (start to end). */
  tangent: Vec2
  /** Tangent angle in degrees, counter-clockwise from +x. */
  angleDeg: number
}

/** Closest point on any of the given polylines to `target`, in the same coordinates. */
export function closestOnCurves(curves: (Vec2[] | null)[], target: Vec2): CurveProbe | null {
  let best: CurveProbe | null = null
  let bestDist = Infinity
  curves.forEach((pts, ci) => {
    if (!pts) return
    for (let k = 0; k + 1 < pts.length; k++) {
      const dx = pts[k + 1][0] - pts[k][0]
      const dy = pts[k + 1][1] - pts[k][1]
      const len2 = dx * dx + dy * dy
      if (len2 < 1e-18) continue
      const t = Math.min(
        Math.max(((target[0] - pts[k][0]) * dx + (target[1] - pts[k][1]) * dy) / len2, 0),
        1,
      )
      const dist = Math.hypot(pts[k][0] + t * dx - target[0], pts[k][1] + t * dy - target[1])
      if (dist < bestDist) {
        bestDist = dist
        best = { curve: ci, segment: k, t }
      }
    }
  })
  return best
}

/** Point and tangent of a probe on the given polyline (the tangent of the probed segment). */
export function readProbe(pts: Vec2[] | undefined, probe: CurveProbe): ProbeReading | null {
  const a = pts?.[probe.segment]
  const b = pts?.[probe.segment + 1]
  if (!a || !b) return null
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len = Math.hypot(dx, dy)
  if (len < 1e-12) return null
  return {
    point: [a[0] + probe.t * dx, a[1] + probe.t * dy],
    tangent: [dx / len, dy / len],
    angleDeg: (Math.atan2(dy, dx) * 180) / Math.PI,
  }
}

export function usePrefersDark(): boolean {
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