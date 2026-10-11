import type { Frame, FrameMeta, FrameSet, PhysicsConstants, ProblemInput, Vec2 } from './types'
import { DEFAULT_CONSTANTS, EPS_STABILIZE } from './types'
import { validateInput } from './validate'
import {
  computeAcceleration,
  computeKineticEnergy,
  copyPoints,
  enforceOrientationConstraints,
  verifyFinite,
} from './forces'

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

/** Fallback spacing when anchors coincide (chord length ~ 0). */
const FALLBACK_SPACING = 1

/**
 * Initialize points and velocities: a straight chord between the two
 * orientation-anchored neighbours, with a small perpendicular jitter on the
 * free interior points so a perfectly straight start (a degenerate
 * equilibrium for the bend forces) is unlikely.
 */
function initializePoints(input: ProblemInput, random: () => number): { pts: Vec2[]; vel: Vec2[] } {
  const { n, start, end, startDir, endDir } = input
  const N = n + 2

  const d0 = normalize(startDir)
  const d1 = normalize(endDir)

  const D = Math.hypot(end[0] - start[0], end[1] - start[1])

  // Coincident-anchor branch: when start and end are effectively the same point,
  // use a circular layout around the anchor instead of a degenerate chord.
  const o = D < EPS_STABILIZE ? FALLBACK_SPACING : D / (n + 1)

  const pts: Vec2[] = new Array(N)
  const vel: Vec2[] = new Array(N)

  // Fixed endpoints
  pts[0] = [start[0], start[1]]
  pts[N - 1] = [end[0], end[1]]
  vel[0] = [0, 0]
  vel[N - 1] = [0, 0]

  // First and last free points
  pts[1] = [start[0] + o * d0[0], start[1] + o * d0[1]]
  pts[n] = [end[0] - o * d1[0], end[1] - o * d1[1]]
  vel[1] = [0, 0]
  vel[n] = [0, 0]

  // Interior free points: when anchors coincide, lay out on a circle of radius o;
  // otherwise use the existing chord+jitter path.
  if (D < EPS_STABILIZE) {
    // Coincident anchors: fill free points on a circle around the anchor
    const th_start = Math.atan2(d0[1], d0[0])
    const th_end = Math.atan2(-d1[1], -d1[0])
    let sweep = ((th_end - th_start) % (2 * Math.PI) + 2 * Math.PI) % (2 * Math.PI)
    if (sweep < EPS_STABILIZE) sweep = 2 * Math.PI // go the long way around
    for (let k = 2; k < n; k++) {
      const th_k = th_start + sweep * (k - 1) / (n - 1)
      pts[k] = [start[0] + o * Math.cos(th_k), start[1] + o * Math.sin(th_k)]
      vel[k] = [0, 0]
    }
  } else {
    // General path: chord with perpendicular jitter
    const p1 = pts[1]
    const pn = pts[n]
    const dp = [pn[0] - p1[0], pn[1] - p1[1]]
    const dpLen = Math.hypot(dp[0], dp[1])
    const perp: Vec2 | null = dpLen >= EPS_STABILIZE ? [-dp[1] / dpLen, dp[0] / dpLen] : null

    for (let k = 2; k < n; k++) {
      const t = (k - 1) / (n - 1)
      let x = p1[0] + t * dp[0]
      let y = p1[1] + t * dp[1]
      if (perp) {
        const amp = INIT_JITTER * o * (2 * random() - 1)
        x += amp * perp[0]
        y += amp * perp[1]
      }
      pts[k] = [x, y]
      vel[k] = [0, 0]
    }
  }

  return { pts, vel }
}

function normalize(v: Vec2): Vec2 {
  const len = Math.hypot(v[0], v[1])
  if (len < EPS_STABILIZE) return [0, 0]
  return [v[0] / len, v[1] / len]
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
  input: ProblemInput,
  constants: PhysicsConstants = DEFAULT_CONSTANTS,
  options: SolveOptions = {},
): FrameSet {
  // Validate input
  const issues = validateInput(input)
  if (issues.length > 0) {
    throw new Error(`Invalid input: ${issues.map((i) => i.message).join('; ')}`)
  }

  const { onProgress, shouldCancel, random = Math.random } = options
  const { n, startDir, endDir } = input
  const N = n + 2
  const { h, epsilon, settleFrames, maxIter } = constants

  // Initialize
  const { pts, vel } = initializePoints(input, random)

  // Record initial frame (i = 0)
  const frames: Frame[] = []
  const initialKe = computeKineticEnergy(vel)
  frames.push({ i: 0, ke: initialKe, pts: copyPoints(pts) })

  // Progress reporting
  const { report, finalize } = makeProgressReporter(onProgress, maxIter)
  report(0, initialKe, true) // Force initial report

  let termination: 'ke' | 'maxIter' = 'maxIter'
  let kePeak = initialKe
  let settleStreak = 0

  // Main simulation loop
  for (let i = 1; i <= maxIter; i++) {
    // Cancellation check
    if (shouldCancel?.()) {
      throw new CancelledError()
    }

    // Compute acceleration
    const accel = computeAcceleration(pts, vel, constants)

    // Verify finite before integration
    verifyFinite(pts, vel, accel)

    // Semi-implicit Euler integration (free points only: 1..n)
    for (let k = 1; k <= n; k++) {
      vel[k][0] += h * accel[k][0]
      vel[k][1] += h * accel[k][1]
      pts[k][0] += h * vel[k][0]
      pts[k][1] += h * vel[k][1]
    }

    // Enforce orientation constraints (hard constraints)
    enforceOrientationConstraints(pts, vel, startDir, endDir)

    // Verify finite after constraints
    verifyFinite(pts, vel, accel)

    // Compute kinetic energy
    const ke = computeKineticEnergy(vel)
    if (ke > kePeak) kePeak = ke

    if (ke < epsilon) settleStreak += 1
    else settleStreak = 0

    // Record frame
    frames.push({ i, ke, pts: copyPoints(pts) })

    // Progress report
    report(i, ke)

    // Termination check
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

  const meta: FrameMeta = {
    n,
    N,
    input,
    constants,
    termination,
    frameCount: frames.length,
  }

  return {
    version: 1,
    meta,
    frames,
  }
}