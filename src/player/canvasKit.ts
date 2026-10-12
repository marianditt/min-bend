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
  start: string
  end: string
  orient: string
}

export const LIGHT_THEME: Theme = {
  bg: '#f8f9fb',
  grid: 'rgba(20, 25, 35, 0.055)',
  axis: '#4b5563',
  chain: '#1f2530',
  point: '#3563e9',
  pointRing: 'rgba(255, 255, 255, 0.95)',
  start: '#128a43',
  end: '#cf2e2e',
  orient: '#b45309',
}

export const DARK_THEME: Theme = {
  bg: '#0b0d11',
  grid: 'rgba(255, 255, 255, 0.05)',
  axis: '#8b95a7',
  chain: '#e6e9ef',
  point: '#7aa2ff',
  pointRing: 'rgba(11, 13, 17, 0.95)',
  start: '#4ade80',
  end: '#f87272',
  orient: '#fbbf24',
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