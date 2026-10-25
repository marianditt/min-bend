import type { FrameSet } from '../solver/types'
import type { Bounds } from './scaleEase'
import { type CurveProbe, type Theme, curveColor, makeProjector, niceStep, readProbe } from './canvasKit'

/** Which parts of the playback frame are drawn (and therefore exported). */
export interface ViewOptions {
  grid: boolean
  axes: boolean
  curves: boolean
  controlPoints: boolean
  interiorPoints: boolean
  directions: boolean
}

export const DEFAULT_VIEW_OPTIONS: ViewOptions = {
  grid: true,
  axes: true,
  curves: true,
  controlPoints: true,
  interiorPoints: true,
  directions: true,
}

export interface PathPrim {
  kind: 'path'
  pts: [number, number][]
  closed?: boolean
  stroke?: string
  fill?: string
  width?: number
}

export interface CirclePrim {
  kind: 'circle'
  x: number
  y: number
  r: number
  stroke?: string
  fill?: string
  width?: number
}

export type Prim = PathPrim | CirclePrim

/** Backend-neutral description of one frame, in screen units (y down). Canvas, SVG and PDF all render this. */
export interface Scene {
  width: number
  height: number
  bg: string
  items: Prim[]
}

function arrow(items: Prim[], x0: number, y0: number, x1: number, y1: number, color: string) {
  const dx = x1 - x0
  const dy = y1 - y0
  const length = Math.hypot(dx, dy)
  if (length < 1e-6) return
  const ux = dx / length
  const uy = dy / length
  const head = 8
  items.push({ kind: 'path', pts: [[x0, y0], [x1 - ux * head * 0.5, y1 - uy * head * 0.5]], stroke: color, width: 2 })
  items.push({
    kind: 'path',
    closed: true,
    fill: color,
    pts: [
      [x1, y1],
      [x1 - ux * head - uy * head * 0.55, y1 - uy * head + ux * head * 0.55],
      [x1 - ux * head + uy * head * 0.55, y1 - uy * head - ux * head * 0.55],
    ],
  })
}

export function buildScene(
  frameSet: FrameSet,
  frameIndex: number,
  width: number,
  height: number,
  bounds: Bounds,
  theme: Theme,
  dark: boolean,
  hidden: boolean[],
  probe: CurveProbe | null,
  options: ViewOptions,
): Scene {
  const items: Prim[] = []
  const scene: Scene = { width, height, bg: theme.bg, items }
  const project = makeProjector(bounds, width, height)
  const { scale, cx, cy, toX, toY } = project
  const left = cx - width / (2 * scale)
  const right = cx + width / (2 * scale)
  const bottom = cy - height / (2 * scale)
  const top = cy + height / (2 * scale)

  if (options.grid) {
    const step = niceStep(48 / scale)
    for (let wx = Math.ceil(left / step) * step; wx <= right; wx += step) {
      const sx = Math.round(toX(wx)) + 0.5
      items.push({ kind: 'path', pts: [[sx, 0], [sx, height]], stroke: theme.grid, width: 1 })
    }
    for (let wy = Math.ceil(bottom / step) * step; wy <= top; wy += step) {
      const sy = Math.round(toY(wy)) + 0.5
      items.push({ kind: 'path', pts: [[0, sy], [width, sy]], stroke: theme.grid, width: 1 })
    }
  }
  if (options.axes) {
    if (left <= 0 && right >= 0) {
      const sx = Math.round(toX(0))
      items.push({ kind: 'path', pts: [[sx, 0], [sx, height]], stroke: theme.axis, width: 2 })
    }
    if (bottom <= 0 && top >= 0) {
      const sy = Math.round(toY(0))
      items.push({ kind: 'path', pts: [[0, sy], [width, sy]], stroke: theme.axis, width: 2 })
    }
  }

  const { frames } = frameSet
  if (frames.length === 0) return scene
  const index = Math.min(Math.max(frameIndex, 0), frames.length - 1)
  const curves = frames[index].curves
  const inputCurves = frameSet.meta.input?.curves ?? []

  curves.forEach((pts, ci) => {
    if (!pts || pts.length === 0 || hidden[ci]) return
    const screen: [number, number][] = pts.map(([x, y]) => [toX(x), toY(y)])
    const control = frames[index].controlIndices?.[ci] ?? []
    const controlSet = new Set(control)
    const curve = inputCurves[ci]

    if (options.curves && screen.length >= 2) {
      items.push({ kind: 'path', pts: screen, stroke: curveColor(ci, dark), width: 2.4 })
    }
    if (options.interiorPoints) {
      screen.forEach(([x, y], i) => {
        if (!controlSet.has(i)) items.push({ kind: 'circle', x, y, r: 3, fill: theme.interior, stroke: theme.pointRing, width: 1.2 })
      })
    }
    if (options.directions) {
      curve?.fixPoints.forEach((fp, pi) => {
        const p = screen[control[pi]]
        if (!p || !fp.orientation) return
        const len = Math.hypot(fp.orientation[0], fp.orientation[1])
        if (len < 1e-9) return
        arrow(items, p[0], p[1], p[0] + (fp.orientation[0] / len) * 30, p[1] - (fp.orientation[1] / len) * 30, theme.orient)
      })
    }
    if (options.controlPoints) {
      curve?.fixPoints.forEach((fp, pi) => {
        const p = screen[control[pi]]
        if (!p) return
        items.push({
          kind: 'circle',
          x: p[0],
          y: p[1],
          r: 6,
          fill: fp.posFree ? theme.controlFree : theme.controlFixed,
          stroke: theme.controlRing,
          width: 1.8,
        })
      })
    }
  })

  if (probe && !hidden[probe.curve]) {
    const reading = readProbe(curves[probe.curve], probe)
    if (reading) {
      const x = toX(reading.point[0])
      const y = toY(reading.point[1])
      arrow(items, x, y, x + reading.tangent[0] * 48, y - reading.tangent[1] * 48, theme.probe)
      items.push({ kind: 'circle', x, y, r: 7, stroke: theme.probe, width: 2 })
    }
  }
  return scene
}

export function renderScene(ctx: CanvasRenderingContext2D, scene: Scene) {
  ctx.fillStyle = scene.bg
  ctx.fillRect(0, 0, scene.width, scene.height)
  ctx.lineJoin = 'round'
  ctx.lineCap = 'round'
  for (const item of scene.items) {
    ctx.beginPath()
    if (item.kind === 'circle') ctx.arc(item.x, item.y, item.r, 0, Math.PI * 2)
    else {
      item.pts.forEach(([x, y], i) => (i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y)))
      if (item.closed) ctx.closePath()
    }
    if (item.fill) {
      ctx.fillStyle = item.fill
      ctx.fill()
    }
    if (item.stroke) {
      ctx.strokeStyle = item.stroke
      ctx.lineWidth = item.width ?? 1
      ctx.stroke()
    }
  }
}

interface Rgba {
  r: number
  g: number
  b: number
  a: number
}

export function parseColor(color: string): Rgba {
  const hex = /^#([0-9a-f]{3}|[0-9a-f]{6})$/i.exec(color)
  if (hex) {
    const h = hex[1].length === 3 ? [...hex[1]].map((c) => c + c).join('') : hex[1]
    return { r: parseInt(h.slice(0, 2), 16), g: parseInt(h.slice(2, 4), 16), b: parseInt(h.slice(4, 6), 16), a: 1 }
  }
  const m = /^rgba?\(\s*([\d.]+)[,\s]+([\d.]+)[,\s]+([\d.]+)(?:[,\s/]+([\d.]+))?\s*\)$/i.exec(color)
  if (m) return { r: Number(m[1]), g: Number(m[2]), b: Number(m[3]), a: m[4] === undefined ? 1 : Number(m[4]) }
  return { r: 0, g: 0, b: 0, a: 1 }
}

const hex2 = (n: number) => Math.round(Math.min(255, Math.max(0, n))).toString(16).padStart(2, '0')
const num = (n: number) => String(Math.round(n * 1000) / 1000)

function svgPaint(attr: 'fill' | 'stroke', color: string | undefined): string {
  if (!color) return ` ${attr}="none"`
  const c = parseColor(color)
  const opacity = c.a < 1 ? ` ${attr}-opacity="${num(c.a)}"` : ''
  return ` ${attr}="#${hex2(c.r)}${hex2(c.g)}${hex2(c.b)}"${opacity}`
}

export function sceneToSvg(scene: Scene): string {
  const { width, height } = scene
  const body = scene.items.map((item) => {
    const style = `${svgPaint('fill', item.fill)}${svgPaint('stroke', item.stroke)}${
      item.stroke ? ` stroke-width="${num(item.width ?? 1)}" stroke-linecap="round" stroke-linejoin="round"` : ''
    }`
    if (item.kind === 'circle') return `<circle cx="${num(item.x)}" cy="${num(item.y)}" r="${num(item.r)}"${style}/>`
    const d = item.pts.map(([x, y], i) => `${i === 0 ? 'M' : 'L'}${num(x)} ${num(y)}`).join('') + (item.closed ? 'Z' : '')
    return `<path d="${d}"${style}/>`
  })
  return [
    `<svg xmlns="http://www.w3.org/2000/svg" width="${num(width)}" height="${num(height)}" viewBox="0 0 ${num(width)} ${num(height)}">`,
    `<rect width="100%" height="100%"${svgPaint('fill', scene.bg)}/>`,
    ...body,
    '</svg>',
  ].join('\n')
}

/** A single-page vector PDF whose page matches the frame size (1 CSS pixel = 1 point). */
export function sceneToPdf(scene: Scene): Uint8Array {
  const { width, height } = scene
  const bg = parseColor(scene.bg)
  // PDF has no cheap alpha without graphics states, so translucent colors are flattened onto the background.
  const rgb = (color: string) => {
    const c = parseColor(color)
    const mix = (v: number, b: number) => (c.a * v + (1 - c.a) * b) / 255
    return `${num(mix(c.r, bg.r))} ${num(mix(c.g, bg.g))} ${num(mix(c.b, bg.b))}`
  }
  const y = (v: number) => num(height - v)
  const k = 0.5522847498
  const ops: string[] = [`${rgb(scene.bg)} rg`, `0 0 ${num(width)} ${num(height)} re f`, '1 J 1 j']
  for (const item of scene.items) {
    if (item.kind === 'circle') {
      const { x, r } = item
      const cy = height - item.y
      const o = r * k
      ops.push(
        `${num(x + r)} ${num(cy)} m`,
        `${num(x + r)} ${num(cy + o)} ${num(x + o)} ${num(cy + r)} ${num(x)} ${num(cy + r)} c`,
        `${num(x - o)} ${num(cy + r)} ${num(x - r)} ${num(cy + o)} ${num(x - r)} ${num(cy)} c`,
        `${num(x - r)} ${num(cy - o)} ${num(x - o)} ${num(cy - r)} ${num(x)} ${num(cy - r)} c`,
        `${num(x + o)} ${num(cy - r)} ${num(x + r)} ${num(cy - o)} ${num(x + r)} ${num(cy)} c h`,
      )
    } else {
      item.pts.forEach(([px, py], i) => ops.push(`${num(px)} ${y(py)} ${i === 0 ? 'm' : 'l'}`))
      if (item.closed) ops.push('h')
    }
    if (item.fill) ops.push(`${rgb(item.fill)} rg`)
    if (item.stroke) ops.push(`${rgb(item.stroke)} RG`, `${num(item.width ?? 1)} w`)
    ops.push(item.fill && item.stroke ? 'B' : item.fill ? 'f' : item.stroke ? 'S' : 'n')
  }
  const stream = ops.join('\n')
  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${num(width)} ${num(height)}] /Contents 4 0 R /Resources << >> >>`,
    `<< /Length ${stream.length} >>\nstream\n${stream}\nendstream`,
  ]
  let out = '%PDF-1.4\n'
  const offsets: number[] = []
  objects.forEach((body, i) => {
    offsets.push(out.length)
    out += `${i + 1} 0 obj\n${body}\nendobj\n`
  })
  const xref = out.length
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`
  out += offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`
  return new TextEncoder().encode(out)
}

export type ExportFormat = 'png' | 'svg' | 'pdf'

export const EXPORT_FORMATS: { value: ExportFormat; label: string }[] = [
  { value: 'png', label: 'PNG image' },
  { value: 'svg', label: 'SVG (vector)' },
  { value: 'pdf', label: 'PDF (vector)' },
]

const PNG_SCALE = 2

async function sceneToPng(scene: Scene): Promise<Blob> {
  const canvas = document.createElement('canvas')
  canvas.width = Math.max(1, Math.round(scene.width * PNG_SCALE))
  canvas.height = Math.max(1, Math.round(scene.height * PNG_SCALE))
  const ctx = canvas.getContext('2d')
  if (!ctx) throw new Error('Canvas is not available in this browser.')
  ctx.scale(PNG_SCALE, PNG_SCALE)
  renderScene(ctx, scene)
  return new Promise((resolve, reject) =>
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error('Could not create the PNG.'))), 'image/png'),
  )
}

export async function exportScene(scene: Scene, format: ExportFormat): Promise<Blob> {
  if (format === 'svg') return new Blob([sceneToSvg(scene)], { type: 'image/svg+xml' })
  if (format === 'pdf') return new Blob([sceneToPdf(scene) as BlobPart], { type: 'application/pdf' })
  return sceneToPng(scene)
}

export function downloadBlob(blob: Blob, filename: string) {
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
