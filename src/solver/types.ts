// Shared contract for the min-bend solver and renderer.
// FROZEN: both the solver and the UI are built against these types.
//
// The system is a set of INDEPENDENT elastic curves. Each curve is a chain of
// fix points with `n` interior points between every consecutive pair (a span).
// A fix point has an optional tangent orientation that binds the interior point
// adjacent to it on each side to lie on its ray (tangent continuity).
//
// Extend only additively where possible.

export type Vec2 = [number, number]

/**
 * An anchor of a curve: a required position with an optional tangent
 * orientation. A non-null orientation constrains the interior point adjacent to
 * this fix point in each neighbouring span to lie on this ray: the outgoing
 * span's first point and the incoming span's last point.
 */
export interface FixPoint {
  /** Fixed position. */
  pos: Vec2
  /** Tangent direction at this point, or null when free. Normalized by the solver. */
  orientation: Vec2 | null
}

/**
 * A single elastic curve: two or more fix points, with `n` interior points
 * between each consecutive pair (span). `spans[i]` holds the user-placed FREE
 * interior points for the span between fixPoints[i] and fixPoints[i+1], in
 * order. Bound points (the interior point adjacent to an oriented fix point)
 * are derived by the solver and are not stored here.
 */
export interface Curve {
  fixPoints: FixPoint[]
  /** Interior points per span (integer >= 0), uniform across the curve. */
  n: number
  /** Per-span user free points; length should equal fixPoints.length - 1. */
  spans: Vec2[][]
  /**
   * Optional target total path length (sum of every segment length in the
   * curve's concatenated polyline). When set, the solver targets the uniform
   * per-segment length `targetLength / (spans * (n + 1))` instead of the
   * geometric mean. null/absent = no constraint.
   */
  targetLength?: number | null
  /**
   * Display-only visibility flag. A hidden curve still participates in the
   * simulation and stays in the result; the player and its plots simply skip
   * drawing it and omit it from the curve selector.
   */
  hidden?: boolean
}

/** The whole multi-curve setup authored by the user. */
export interface Setup {
  curves: Curve[]
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
  /** Safety cap on the per-point net force (mass = 1, so this bounds acceleration). */
  maxForce: number
}

export const DEFAULT_CONSTANTS: PhysicsConstants = {
  kLen: 100,
  kBend: 1,
  gamma: 0.1,
  h: 0.01,
  epsilon: 1e-4,
  settleFrames: 30,
  maxIter: 100000,
  maxForce: 1000,
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
