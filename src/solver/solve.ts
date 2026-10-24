import type { Curve, Frame, FrameMeta, FrameSet, PhysicsConstants, Setup, Vec2 } from './types'
import { DEFAULT_CONSTANTS } from './types'
import { validateSetup } from './validate'
import {
  type ChainModel,
  type PointConstraint,
  computeAcceleration,
  computeKineticEnergy,
  enforceConstraints,
  verifyFinite,
} from './forces'
import { createFrameBuffer } from './frameBuffer'
import { planCurve, safeResolution, sampleAlong, unitOrNull } from './curve'
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

/** One curve as a single polyline with its constraint model. */
interface ChainState {
  pts: Vec2[]
  vel: Vec2[]
  model: ChainModel
  controlIndices: number[]
}

function buildChain(curve: Curve, resolution: number, random: () => number): ChainState {
  const res = safeResolution(resolution)
  const plan = planCurve(curve, res)
  const pts: Vec2[] = []

  plan.spans.forEach((span, si) => {
    const distances: number[] = [0]
    for (const len of span.lengths) distances.push(distances[distances.length - 1] + len)
    distances[distances.length - 1] = span.length
    const sampled = sampleAlong(span.polyline, distances)

    // Perpendicular jitter relative to the chord, away from the span ends.
    const a = curve.fixPoints[si]
    const b = curve.fixPoints[si + 1]
    const dx = b.pos[0] - a.pos[0]
    const dy = b.pos[1] - a.pos[1]
    const chord = Math.hypot(dx, dy)
    if (chord > 1e-3) {
      const perp: Vec2 = [-dy / chord, dx / chord]
      const spacing = span.length / span.segments
      for (let k = 2; k < span.segments - 1; k++) {
        const amp = INIT_JITTER * spacing * (2 * random() - 1)
        sampled[k] = [sampled[k][0] + amp * perp[0], sampled[k][1] + amp * perp[1]]
      }
    }

    const d0 = unitOrNull(a.orientation)
    const d1 = unitOrNull(b.orientation)
    const first = span.lengths[0]
    const lastLen = Math.max(span.lengths[span.segments - 1], 0.3 * first)
    if (d0) sampled[1] = [a.pos[0] + first * d0[0], a.pos[1] + first * d0[1]]
    if (d1) {
      sampled[span.segments - 1] = [b.pos[0] - lastLen * d1[0], b.pos[1] - lastLen * d1[1]]
    }

    const from = si === 0 ? 0 : 1
    for (let k = from; k < sampled.length; k++) pts.push([sampled[k][0], sampled[k][1]])
  })

  const total = pts.length
  const movable: boolean[] = new Array(total).fill(true)
  const constraints: PointConstraint[] = []
  const lastControl = curve.fixPoints.length - 1
  curve.fixPoints.forEach((fp, j) => {
    const idx = plan.controlIndices[j]
    const posFree = fp.posFree === true
    if (!posFree) movable[idx] = false
    const dir = unitOrNull(fp.orientation)
    if (dir) constraints.push({ index: idx, dir, collinear: false })
    else if (!posFree && j > 0 && j < lastControl) constraints.push({ index: idx, dir: null, collinear: true })
  })

  const target = curve.targetLength
  const segmentCount = plan.segmentCount
  const targets: number[] = []
  if (target != null && Number.isFinite(target) && segmentCount > 0) {
    for (let k = 0; k < segmentCount; k++) {
      targets.push(target / segmentCount)
    }
  } else {
    for (const span of plan.spans) targets.push(...span.lengths)
  }

  const model: ChainModel = { movable, targets, constraints }
  const vel: Vec2[] = pts.map(() => [0, 0])
  enforceConstraints(pts, vel, constraints)
  return { pts, vel, model, controlIndices: plan.controlIndices }
}

function totalKineticEnergy(chains: ChainState[]): number {
  let ke = 0
  for (const chain of chains) ke += computeKineticEnergy(chain.vel)
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

  const chains = setup.curves.map((curve) => buildChain(curve, setup.resolution, random))
  const curvePointCounts = chains.map((chain) => chain.pts.length)
  const controlIndices = chains.map((chain) => chain.controlIndices)
  const N = curvePointCounts.reduce((sum, count) => sum + count, 0)

  const captureCurves = (): Vec2[][] => chains.map((chain) => chain.pts.map((p): Vec2 => [p[0], p[1]]))

  const buffer = createFrameBuffer()
  const initialKe = totalKineticEnergy(chains)
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

    for (const chain of chains) {
      const { pts, vel, model } = chain
      const accel = computeAcceleration(pts, vel, constants, model)
      verifyFinite(pts, vel, accel)

      for (let k = 0; k < pts.length; k++) {
        if (!model.movable[k]) continue
        vel[k][0] += h * accel[k][0]
        vel[k][1] += h * accel[k][1]
        pts[k][0] += h * vel[k][0]
        pts[k][1] += h * vel[k][1]
      }

      enforceConstraints(pts, vel, model.constraints)
      verifyFinite(pts, vel, accel)
    }

    const ke = totalKineticEnergy(chains)
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
    controlIndices,
    N,
    curveCount: chains.length,
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
  return setup.curves.map((curve) => buildChain(curve, setup.resolution, () => 0.5).pts)
}
