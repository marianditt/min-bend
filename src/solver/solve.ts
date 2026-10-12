import type { Frame, FrameMeta, FrameSet, PhysicsConstants, Setup, Vec2 } from './types'
import { DEFAULT_CONSTANTS, EPS_STABILIZE } from './types'
import { validateSetup } from './validate'
import {
  computeAcceleration,
  computeKineticEnergy,
  enforceOrientationConstraints,
  length,
  normalize,
  verifyFinite,
} from './forces'
import { createFrameBuffer } from './frameBuffer'
import { freeSlotsFor } from './curve'

/** Thrown by solve() when shouldCancel() returns true. */
export class CancelledError extends Error {
  constructor() {
    super('cancelled')
    this.name = 'CancelledError'
  }
}

export interface SolveOptions {
  onProgress?: (progress: number, iteration: number, ke: number) => void
  shouldCancel?: () => boolean
  /** Uniform [0,1) source for the initial-pose jitter. Math.random by default. */
  random?: () => number
}

/** Initial-pose jitter amplitude, as a fraction of the segment spacing. */
const INIT_JITTER = 0.15

/** Fallback spacing when a span's anchors coincide (chord length ~ 0). */
const FALLBACK_SPACING = 1

/** A normalized span: fix endpoints plus the optional tangent directions. */
interface SpanSpec {
  a: Vec2
  b: Vec2
  n: number
  aDir: Vec2 | null
  bDir: Vec2 | null
  free: Vec2[]
}

interface SpanState {
  pts: Vec2[]
  vel: Vec2[]
  aDir: Vec2 | null
  bDir: Vec2 | null
}

interface CurveRange {
  start: number
  count: number
}

interface NormalizedSetup {
  specs: SpanSpec[]
  curveRanges: CurveRange[]
}

/**
 * Flatten a setup into independent spans (one per consecutive fix-point pair).
 * Each span carries its own tangent directions: a span's start direction is the
 * start fix point's orientation and its end direction is the end fix point's
 * orientation. `free` is clamped to at most `n` points.
 */
function normalizeSetup(setup: Setup): NormalizedSetup {
  const specs: SpanSpec[] = []
  const curveRanges: CurveRange[] = []

  for (const curve of setup.curves) {
    const start = specs.length
    const n = Math.max(0, Math.floor(curve.n))
    const fixPoints = Array.isArray(curve.fixPoints) ? curve.fixPoints : []

    for (let s = 0; s + 1 < fixPoints.length; s++) {
      const fpA = fixPoints[s]
      const fpB = fixPoints[s + 1]
      const spanFree = Array.isArray(curve.spans?.[s]) ? curve.spans[s] : []
      specs.push({
        a: fpA.pos,
        b: fpB.pos,
        n,
        aDir: fpA.orientation ?? null,
        bDir: fpB.orientation ?? null,
        free: spanFree.slice(0, n),
      })
    }

    curveRanges.push({ start, count: specs.length - start })
  }

  return { specs, curveRanges }
}

/** +1 for the endpoint shared with the next span, plus the first span's first point. */
function curvePointCount(specs: SpanSpec[], range: CurveRange): number {
  let count = 1
  for (let s = range.start; s < range.start + range.count; s++) count += specs[s].n + 1
  return count
}

function reassembleCurve(spans: SpanState[], range: CurveRange): Vec2[] {
  const out: Vec2[] = []
  for (let s = range.start; s < range.start + range.count; s++) {
    const pts = spans[s].pts
    const from = s === range.start ? 0 : 1
    for (let k = from; k < pts.length; k++) out.push([pts[k][0], pts[k][1]])
  }
  return out
}

/** Fill unset interior slots by repeatedly splitting the largest spatial gap. */
function gapFill(pts: Vec2[], unsetSlots: number[]): void {
  const unset = new Set(unsetSlots)
  const known: number[] = []
  for (let k = 0; k < pts.length; k++) if (!unset.has(k)) known.push(k)
  const remaining = [...unsetSlots].sort((x, y) => x - y)

  while (remaining.length > 0) {
    known.sort((x, y) => x - y)
    let bestGap = -1
    let bestPair = -1
    for (let g = 0; g + 1 < known.length; g++) {
      const k1 = known[g]
      const k2 = known[g + 1]
      if (!remaining.some((s) => s > k1 && s < k2)) continue
      const dist = Math.hypot(pts[k2][0] - pts[k1][0], pts[k2][1] - pts[k1][1])
      if (dist > bestGap) {
        bestGap = dist
        bestPair = g
      }
    }
    if (bestPair < 0) break
    const k1 = known[bestPair]
    const k2 = known[bestPair + 1]
    const between = remaining.filter((s) => s > k1 && s < k2)
    const slot = between[Math.floor((between.length - 1) / 2)]
    pts[slot] = [(pts[k1][0] + pts[k2][0]) / 2, (pts[k1][1] + pts[k2][1]) / 2]
    known.push(slot)
    remaining.splice(remaining.indexOf(slot), 1)
  }
}

/**
 * Deterministic (no-jitter) layout for one span. Generalizes the original
 * single-chain layout to optional end orientations:
 *   - user free points occupy the free slots in order, remainder gap-filled;
 *   - otherwise a chord layout is used, or a circular layout when the anchors
 *     coincide (D < EPS_STABILIZE);
 *   - an n = 1 span bound at both ends is left to the orientation projection.
 */
function computeSpanBase(spec: SpanSpec, random: () => number): Vec2[] {
  const { a, b, n, aDir, bDir, free } = spec
  const N = n + 2
  const pts: Vec2[] = new Array(N)
  pts[0] = [a[0], a[1]]
  pts[N - 1] = [b[0], b[1]]

  if (n === 0) return pts

  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const D = Math.hypot(dx, dy)
  const coincident = D < EPS_STABILIZE
  const o = coincident ? FALLBACK_SPACING : D / (n + 1)

  const d0raw = aDir ? normalize(aDir) : null
  const d1raw = bDir ? normalize(bDir) : null
  const d0 = d0raw && length(d0raw) >= EPS_STABILIZE ? d0raw : null
  const d1 = d1raw && length(d1raw) >= EPS_STABILIZE ? d1raw : null
  const hasStart = d0 !== null
  const hasEnd = d1 !== null

  if (n === 1) {
    if (hasStart && hasEnd) {
      pts[1] = [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
    } else if (hasStart) {
      pts[1] = [a[0] + o * d0![0], a[1] + o * d0![1]]
    } else if (hasEnd) {
      pts[1] = [b[0] - o * d1![0], b[1] - o * d1![1]]
    } else {
      pts[1] = coincident ? [a[0] + o, a[1]] : [(a[0] + b[0]) / 2, (a[1] + b[1]) / 2]
    }
    if (!(hasStart && hasEnd) && free.length > 0) pts[1] = [free[0][0], free[0][1]]
    return pts
  }

  if (coincident && free.length === 0) {
    const thStart = hasStart ? Math.atan2(d0![1], d0![0]) : 0
    const thEnd = hasEnd ? Math.atan2(-d1![1], -d1![0]) : thStart + 2 * Math.PI
    let sweep = ((thEnd - thStart) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI)
    if (sweep < EPS_STABILIZE) sweep = 2 * Math.PI
    pts[1] = [a[0] + o * Math.cos(thStart), a[1] + o * Math.sin(thStart)]
    pts[n] = [a[0] + o * Math.cos(thStart + sweep), a[1] + o * Math.sin(thStart + sweep)]
    for (let k = 2; k < n; k++) {
      const thK = thStart + (sweep * (k - 1)) / (n - 1)
      pts[k] = [a[0] + o * Math.cos(thK), a[1] + o * Math.sin(thK)]
    }
    return pts
  }

  const cux = coincident ? 0 : dx / D
  const cuy = coincident ? 0 : dy / D
  const p1: Vec2 = hasStart ? [a[0] + o * d0![0], a[1] + o * d0![1]] : [a[0] + o * cux, a[1] + o * cuy]
  const pn: Vec2 = hasEnd ? [b[0] - o * d1![0], b[1] - o * d1![1]] : [b[0] - o * cux, b[1] - o * cuy]
  pts[1] = p1
  pts[n] = pn
  for (let k = 2; k < n; k++) {
    const t = (k - 1) / (n - 1)
    pts[k] = [p1[0] + t * (pn[0] - p1[0]), p1[1] + t * (pn[1] - p1[1])]
  }

  if (free.length > 0) {
    const slots = freeSlotsFor(n, hasStart, hasEnd)
    const k = Math.min(free.length, slots.length)
    for (let j = 0; j < k; j++) pts[slots[j]] = [free[j][0], free[j][1]]
    const unset = slots.slice(k)
    if (unset.length > 0) gapFill(pts, unset)
    return pts
  }

  if (!coincident) {
    const dp: Vec2 = [pn[0] - p1[0], pn[1] - p1[1]]
    const dpLen = Math.hypot(dp[0], dp[1])
    if (dpLen >= EPS_STABILIZE) {
      const perp: Vec2 = [-dp[1] / dpLen, dp[0] / dpLen]
      const lo = hasStart ? 2 : 1
      const hi = hasEnd ? n - 1 : n
      for (let k = lo; k <= hi; k++) {
        const amp = INIT_JITTER * o * (2 * random() - 1)
        pts[k] = [pts[k][0] + amp * perp[0], pts[k][1] + amp * perp[1]]
      }
    }
  }

  return pts
}

function initializeSpan(spec: SpanSpec, random: () => number): SpanState {
  const pts = computeSpanBase(spec, random)
  const vel: Vec2[] = new Array(pts.length)
  for (let i = 0; i < pts.length; i++) vel[i] = [0, 0]
  enforceOrientationConstraints(pts, vel, spec.aDir, spec.bDir)
  return { pts, vel, aDir: spec.aDir, bDir: spec.bDir }
}

function totalKineticEnergy(spans: SpanState[]): number {
  let ke = 0
  for (const span of spans) ke += computeKineticEnergy(span.vel)
  return ke
}

/** Report progress with ~50ms throttling, but always at least once and exactly 1.0 at end. */
function makeProgressReporter(
  onProgress: SolveOptions['onProgress'],
  maxIter: number,
): { report: (iteration: number, ke: number, force?: boolean) => void; finalize: () => void } {
  let lastReportTime = 0
  let hasReported = false
  let kePeak = 0

  const report = (iteration: number, ke: number, force = false): void => {
    if (!onProgress) return

    const now = performance.now()
    if (!force && hasReported && now - lastReportTime < 50) return

    if (ke > kePeak) kePeak = ke

    const pIter = iteration / maxIter
    const pKe = kePeak > 0 ? Math.max(0, Math.min(1, 1 - ke / kePeak)) : 0
    const progress = Math.max(pIter, pKe)

    onProgress(progress, iteration, ke)
    lastReportTime = now
    hasReported = true
  }

  const finalize = (): void => {
    if (onProgress && hasReported) {
      // Ensure we report exactly 1.0 at completion
      onProgress(1, maxIter, 0)
    }
  }

  return { report, finalize }
}

export function solve(
  setup: Setup,
  constants: PhysicsConstants = DEFAULT_CONSTANTS,
  options: SolveOptions = {},
): FrameSet {
  const issues = validateSetup(setup)
  if (issues.length > 0) {
    throw new Error(`Invalid setup: ${issues.map((i) => i.message).join('; ')}`)
  }

  const { onProgress, shouldCancel, random = Math.random } = options
  const { h, epsilon, settleFrames, maxIter } = constants

  const { specs, curveRanges } = normalizeSetup(setup)
  const spans = specs.map((spec) => initializeSpan(spec, random))
  const curvePointCounts = curveRanges.map((range) => curvePointCount(specs, range))
  const N = curvePointCounts.reduce((sum, count) => sum + count, 0)

  const captureCurves = (): Vec2[][] => curveRanges.map((range) => reassembleCurve(spans, range))

  const buffer = createFrameBuffer()
  const initialKe = totalKineticEnergy(spans)
  buffer.add({ i: 0, ke: initialKe, curves: captureCurves() })

  const { report, finalize } = makeProgressReporter(onProgress, maxIter)
  report(0, initialKe, true)

  let termination: 'ke' | 'maxIter' = 'maxIter'
  let settleStreak = 0
  let lastIter = 0
  let lastKe = initialKe

  for (let i = 1; i <= maxIter; i++) {
    if (shouldCancel?.()) {
      throw new CancelledError()
    }

    for (const span of spans) {
      const accel = computeAcceleration(span.pts, span.vel, constants)
      verifyFinite(span.pts, span.vel, accel)

      const nFree = span.pts.length - 2
      for (let k = 1; k <= nFree; k++) {
        span.vel[k][0] += h * accel[k][0]
        span.vel[k][1] += h * accel[k][1]
        span.pts[k][0] += h * span.vel[k][0]
        span.pts[k][1] += h * span.vel[k][1]
      }

      enforceOrientationConstraints(span.pts, span.vel, span.aDir, span.bDir)
      verifyFinite(span.pts, span.vel, accel)
    }

    const ke = totalKineticEnergy(spans)
    if (ke < epsilon) settleStreak += 1
    else settleStreak = 0

    buffer.add({ i, ke, curves: captureCurves() })
    lastIter = i
    lastKe = ke

    report(i, ke)

    if (settleStreak >= settleFrames) {
      termination = 'ke'
      break
    }
    if (i >= maxIter) {
      termination = 'maxIter'
      break
    }
  }

  finalize()

  const last: Frame = { i: lastIter, ke: lastKe, curves: captureCurves() }
  const frames = buffer.finish(last)

  const meta: FrameMeta = {
    curvePointCounts,
    N,
    curveCount: curveRanges.length,
    input: setup,
    constants,
    termination,
    frameCount: frames.length,
    iterations: lastIter,
  }

  return {
    version: 1,
    meta,
    frames,
  }
}

/** Deterministic (no-jitter) per-curve initial pose for the setup editor preview. */
export function previewPose(setup: Setup): Vec2[][] {
  const { specs, curveRanges } = normalizeSetup(setup)
  const spans = specs.map((spec) => initializeSpan(spec, () => 0.5))
  return curveRanges.map((range) => reassembleCurve(spans, range))
}
