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
import { freeSlotsFor, totalSegmentCount } from './curve'
import { ProgressTracker } from './progress'

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

/**
 * Per-span reference-length override derived from each curve's optional
 * targetLength: target / total segment count. Undefined keeps the span's
 * geometric-mean reference (no target).
 */
function buildSpanReferenceLengths(
  setup: Setup,
  curveRanges: CurveRange[],
): (number | undefined)[] {
  const refs: (number | undefined)[] = []
  for (let ci = 0; ci < curveRanges.length; ci++) {
    const range = curveRanges[ci]
    const curve = setup.curves[ci]
    const target = curve?.targetLength
    const segments = curve ? totalSegmentCount(curve) : 0
    const reference =
      target != null && Number.isFinite(target) && segments > 0 ? target / segments : undefined
    for (let s = 0; s < range.count; s++) refs[range.start + s] = reference
  }
  return refs
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

/**
 * Deterministic (no-jitter) layout for one span. Generalizes the original
 * single-chain layout to optional end orientations:
 *   - user free points occupy the free slots; leftover slots split the widest gap;
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
    const leftAnchor: Vec2 = hasStart ? pts[1] : pts[0]
    const rightAnchor: Vec2 = hasEnd ? pts[n] : pts[n + 1]
    const seq: Vec2[] = [leftAnchor, ...free.slice(0, k).map((p): Vec2 => [p[0], p[1]]), rightAnchor]
    // Split the widest gap (including between drawn points) one point at a time.
    while (seq.length - 2 < slots.length) {
      let best = 0
      let bestLen = -1
      for (let i = 0; i < seq.length - 1; i++) {
        const len = Math.hypot(seq[i + 1][0] - seq[i][0], seq[i + 1][1] - seq[i][1])
        if (len > bestLen) {
          bestLen = len
          best = i
        }
      }
      seq.splice(best + 1, 0, [(seq[best][0] + seq[best + 1][0]) / 2, (seq[best][1] + seq[best + 1][1]) / 2])
    }
    for (let j = 0; j < slots.length; j++) pts[slots[j]] = seq[j + 1]
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

/**
 * Report progress with ~50ms throttling. The final sample (via `finalize`)
 * always reports 1.0 together with the true last iteration and energy, so the
 * UI never flashes the configured maxIter as if the run had used it all.
 */
function makeProgressReporter(
  onProgress: SolveOptions['onProgress'],
  maxIter: number,
  release: number,
): {
  report: (iteration: number, ke: number, force?: boolean) => void
  finalize: (iteration: number, ke: number) => void
} {
  const tracker = new ProgressTracker(release)
  let lastReportTime = 0
  let hasReported = false

  const report = (iteration: number, ke: number, force = false): void => {
    if (!onProgress) return
    tracker.observe(ke)
    const now = performance.now()
    if (!force && hasReported && now - lastReportTime < 50) return
    onProgress(tracker.progress(iteration, maxIter), iteration, ke)
    lastReportTime = now
    hasReported = true
  }

  const finalize = (iteration: number, ke: number): void => {
    if (onProgress) onProgress(1, iteration, ke)
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
  const spanReferences = buildSpanReferenceLengths(setup, curveRanges)
  const curvePointCounts = curveRanges.map((range) => curvePointCount(specs, range))
  const N = curvePointCounts.reduce((sum, count) => sum + count, 0)

  const captureCurves = (): Vec2[][] => curveRanges.map((range) => reassembleCurve(spans, range))

  const buffer = createFrameBuffer()
  const initialKe = totalKineticEnergy(spans)
  buffer.add({ i: 0, ke: initialKe, curves: captureCurves() })

  const { report, finalize } = makeProgressReporter(
    onProgress,
    maxIter,
    constants.gamma * constants.h,
  )
  report(0, initialKe, true)

  let termination: 'ke' | 'maxIter' = 'maxIter'
  let settleStreak = 0
  let lastIter = 0
  let lastKe = initialKe

  for (let i = 1; i <= maxIter; i++) {
    if (shouldCancel?.()) {
      throw new CancelledError()
    }

    for (let si = 0; si < spans.length; si++) {
      const span = spans[si]
      const accel = computeAcceleration(span.pts, span.vel, constants, spanReferences[si])
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

  finalize(lastIter, lastKe)

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
