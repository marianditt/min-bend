// Shared contract for the min-bend solver and renderer.
//
// The system is a set of INDEPENDENT elastic curves. Each curve is one
// continuous chain through its control points; between consecutive control
// points (a span) the solver inserts as many interior points as the global
// resolution requires.
//
// Control point kinds (position x orientation):
//   - fixed position, free orientation: the point stays put and the incoming
//     and outgoing segments continue smoothly through it (the chain is one
//     polyline, so there is a single orientation); at the curve ends it is free.
//   - free position, fixed orientation: the solver may move the point; both
//     adjacent segments lie on the given tangent line.
//   - fixed position, fixed orientation: both constraints.
//   - free position, free orientation: behaves like an interior point.

export type Vec2 = [number, number]

export interface FixPoint {
  /** Position; the fixed position, or the initial guess when `posFree`. */
  pos: Vec2
  /** Tangent direction at this point, or null when free. Normalized by the solver. */
  orientation: Vec2 | null
  /** When true the solver may move this point to minimize bend. */
  posFree?: boolean
}

/**
 * A single elastic curve: two or more control points. `spans[i]` holds optional
 * user-placed guide points for the span between fixPoints[i] and fixPoints[i+1],
 * in order; they only shape the initial layout.
 */
export interface Curve {
  fixPoints: FixPoint[]
  /** Per-span user guide points; length should equal fixPoints.length - 1. */
  spans: Vec2[][]
  /**
   * Optional target total path length (sum of every segment length in the
   * curve's polyline). When set, the solver targets the uniform per-segment
   * length `targetLength / segmentCount` instead of the mean. null/absent = no
   * constraint.
   */
  targetLength?: number | null
  /**
   * Display-only visibility flag. A hidden curve still participates in the
   * simulation and stays in the result; the player and its plots simply skip
   * drawing it and omit it from the curve selector.
   */
  hidden?: boolean
}

/** Default value of {@link Setup.resolution}. */
export const DEFAULT_RESOLUTION = 1

/** The whole multi-curve setup authored by the user. */
export interface Setup {
  curves: Curve[]
  /** Nominal length of the line between neighboring interior points, shared by all curves. */
  resolution: number
}

/** Tunable physics / solver constants (exposed under "Advanced"). */
export interface PhysicsConstants {
  /** Segment-length force stiffness. */
  kLen: number
  /** Bend-minimization force stiffness. */
  kBend: number
  /** Friction coefficient (force = -gamma * v). */
  gamma: number
  /** Integration step size. */
  h: number
  /** Kinetic-energy threshold for termination. */
  epsilon: number
  /** Consecutive frames with KE below epsilon before termination. */
  settleFrames: number
  /** Safety cap on the number of iterations. */
  maxIter: number
}

export const DEFAULT_CONSTANTS: PhysicsConstants = {
  kLen: 100,
  kBend: 1,
  gamma: 0.1,
  h: 0.01,
  epsilon: 1e-4,
  settleFrames: 30,
  maxIter: 100000,
}

/**
 * Fixed stabilization threshold (not user-adjustable): inputs within this
 * magnitude of degeneracy are rejected.
 */
export const EPS_STABILIZE = 1e-3

/** A single simulation frame. Positions only - no styling. */
export interface Frame {
  /** Frame / iteration index (0-based). */
  i: number
  /** Kinetic energy at this frame. */
  ke: number
  /** Per-curve point polylines (fix points + interior points), in curve order. */
  curves: Vec2[][]
}

export interface FrameMeta {
  /** Number of points per curve, aligned with Frame.curves. */
  curvePointCounts: number[]
  /** Index of every control point within its curve's polyline, aligned with Frame.curves. */
  controlIndices: number[][]
  /** Number of points across all curves. */
  N: number
  /** Number of curves. */
  curveCount: number
  input: Setup
  constants: PhysicsConstants
  /** Why the simulation stopped. */
  termination: 'ke' | 'maxIter'
  /** Number of frames retained for playback (≤ the true iteration count once decimated). */
  frameCount: number
  /** True solver iterations run. Optional so older results stay valid; falls back to frameCount. */
  iterations?: number
}

/** Versioned, extensible result container. */
export interface FrameSet {
  version: 1
  meta: FrameMeta
  frames: Frame[]
}
