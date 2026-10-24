import type { Curve, Vec2 } from './types'
import { EPS_STABILIZE } from './types'

/** Every span gets at least this many segments so control-point neighbors are distinct interior points. */
export const MIN_SEGMENTS = 3

/** Segment count assumed for a span whose anchors coincide and that has no guide points. */
export const FALLBACK_SEGMENTS = 7

/** Upper bound per span; guards against absurdly small resolutions. */
export const MAX_SEGMENTS_PER_SPAN = 5000

const CIRCLE_VERTICES = 64

export interface SpanPlan {
  /** Estimated centerline of the span, from start to end. */
  polyline: Vec2[]
  /** Estimated path length of the span. */
  length: number
  /** Number of segments (>= MIN_SEGMENTS). */
  segments: number
  /** True when the requested resolution would exceed MAX_SEGMENTS_PER_SPAN. */
  overflow: boolean
  /**
   * Initial length of each segment: `resolution` for all but the last, which
   * takes the remainder (and so may be shorter). Short spans use uniform lengths.
   */
  lengths: number[]
}

export interface CurvePlan {
  spans: SpanPlan[]
  /** Index of each control point within the curve's polyline. */
  controlIndices: number[]
  segmentCount: number
}

export function safeResolution(resolution: number): number {
  return Number.isFinite(resolution) && resolution > 0 ? resolution : 1
}

export function unitOrNull(v: Vec2 | null | undefined): Vec2 | null {
  if (!v) return null
  const len = Math.hypot(v[0], v[1])
  return len < EPS_STABILIZE ? null : [v[0] / len, v[1] / len]
}

function polylineLength(poly: Vec2[]): number {
  let total = 0
  for (let i = 0; i + 1 < poly.length; i++) {
    total += Math.hypot(poly[i + 1][0] - poly[i][0], poly[i + 1][1] - poly[i][1])
  }
  return total
}

/** Points on `poly` at the given arc-length distances (clamped to the ends). */
export function sampleAlong(poly: Vec2[], distances: number[]): Vec2[] {
  const out: Vec2[] = []
  let seg = 0
  let segStart = 0
  for (const target of distances) {
    while (seg + 2 < poly.length) {
      const len = Math.hypot(poly[seg + 1][0] - poly[seg][0], poly[seg + 1][1] - poly[seg][1])
      if (segStart + len >= target) break
      segStart += len
      seg += 1
    }
    const a = poly[seg]
    const b = poly[Math.min(seg + 1, poly.length - 1)]
    const len = Math.hypot(b[0] - a[0], b[1] - a[1])
    const t = len < 1e-12 ? 0 : Math.min(Math.max((target - segStart) / len, 0), 1)
    out.push([a[0] + t * (b[0] - a[0]), a[1] + t * (b[1] - a[1])])
  }
  return out
}

/** Plan the discretization of span `si` of a curve for the given global resolution. */
export function planSpan(curve: Curve, si: number, resolution: number): SpanPlan {
  const res = safeResolution(resolution)
  const a = curve.fixPoints[si]
  const b = curve.fixPoints[si + 1]
  const guides = Array.isArray(curve.spans?.[si]) ? curve.spans[si] : []
  const d0 = unitOrNull(a.orientation)
  const d1 = unitOrNull(b.orientation)
  const chord = Math.hypot(b.pos[0] - a.pos[0], b.pos[1] - a.pos[1])

  let polyline: Vec2[]
  if (chord < EPS_STABILIZE && guides.length === 0) {
    // Coincident anchors: lay out a loop leaving along the start tangent.
    const radius = (FALLBACK_SEGMENTS * res) / (2 * Math.PI)
    const dir = d0 ?? [1, 0]
    const left: Vec2 = [-dir[1], dir[0]]
    const center: Vec2 = [a.pos[0] + radius * left[0], a.pos[1] + radius * left[1]]
    const phi = Math.atan2(-left[1], -left[0])
    polyline = []
    for (let j = 0; j <= CIRCLE_VERTICES; j++) {
      const th = phi + (2 * Math.PI * j) / CIRCLE_VERTICES
      polyline.push([center[0] + radius * Math.cos(th), center[1] + radius * Math.sin(th)])
    }
    polyline[0] = [a.pos[0], a.pos[1]]
    polyline[CIRCLE_VERTICES] = [b.pos[0], b.pos[1]]
  } else {
    const handle = Math.max(chord, res) / 3
    polyline = [[a.pos[0], a.pos[1]]]
    if (d0) polyline.push([a.pos[0] + handle * d0[0], a.pos[1] + handle * d0[1]])
    for (const g of guides) polyline.push([g[0], g[1]])
    if (d1) polyline.push([b.pos[0] - handle * d1[0], b.pos[1] - handle * d1[1]])
    polyline.push([b.pos[0], b.pos[1]])
  }

  const length = Math.max(polylineLength(polyline), res * 1e-3)
  const ratio = length / res
  const rawSegments = Math.max(MIN_SEGMENTS, Math.ceil(ratio - 1e-9))
  const overflow = rawSegments > MAX_SEGMENTS_PER_SPAN
  const segments = Math.min(rawSegments, MAX_SEGMENTS_PER_SPAN)

  let lengths: number[]
  if (!overflow && ratio > MIN_SEGMENTS - 1) {
    lengths = new Array(segments).fill(res)
    lengths[segments - 1] = length - (segments - 1) * res
  } else {
    lengths = new Array(segments).fill(length / segments)
  }

  return { polyline, length, segments, overflow, lengths }
}

export function planCurve(curve: Curve, resolution: number): CurvePlan {
  const spans: SpanPlan[] = []
  const controlIndices: number[] = [0]
  let segmentCount = 0
  const spanCount = Math.max(0, (Array.isArray(curve.fixPoints) ? curve.fixPoints.length : 0) - 1)
  for (let si = 0; si < spanCount; si++) {
    const plan = planSpan(curve, si, resolution)
    spans.push(plan)
    segmentCount += plan.segments
    controlIndices.push(segmentCount)
  }
  return { spans, controlIndices, segmentCount }
}
