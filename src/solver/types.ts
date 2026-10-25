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

/** Stable identity of a control point; unaffected by inserting or deleting other points. */
export type PointId = string

export interface FixPoint {
  /** Unique within the setup. Constraints refer to points by this id, never by index. */
  id: PointId
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
   * curve's polyline). When set, a uniform tension along the whole curve pulls
   * the total length toward it. null/absent = the length is free.
   */
  targetLength?: number | null
  /**
   * Only used while the length is free: how the curve trades shortness against
   * flatness, from 0 (as short as possible) to 1 (as flat as possible).
   * Absent = {@link DEFAULT_FLATNESS}.
   */
  flatness?: number
  /**
   * Display-only visibility flag. A hidden curve still participates in the
   * simulation and stays in the result; the player and its plots simply skip
   * drawing it and omit it from the curve selector.
   */
  hidden?: boolean
}

/** Default value of {@link Curve.flatness}: shortness and flatness weigh equally. */
export const DEFAULT_FLATNESS = 0.5

/** Default value of {@link Setup.resolution}. */
export const DEFAULT_RESOLUTION = 1

/** Addresses one control point by position in the setup (derived from a {@link PointId}; never stored). */
export interface PointRef {
  curve: number
  point: number
}

interface ConstraintBase {
  /** The followed point (possibly on another curve). */
  source: PointId
  /** The point whose own input for this property is replaced. */
  target: PointId
}

/** The target sits at the source's position plus `delta` (default [0, 0]). */
export interface PositionConstraint extends ConstraintBase {
  kind: 'position'
  delta?: Vec2
}

/** The target's tangent is the source's tangent rotated counter-clockwise by `delta` degrees (default 0). */
export interface OrientationConstraint extends ConstraintBase {
  kind: 'orientation'
  delta?: number
}

/**
 * Ties one property of the `target` control point to the `source` control
 * point, optionally with a fixed offset. The target's own input for that
 * property is ignored.
 *  - position: a fixed source pins the target; if the source is free the solver
 *    keeps both points together at the offset.
 *  - orientation: a fixed source gives the target a fixed tangent; if the
 *    source's orientation is free, the solver keeps both tangents at the angular
 *    offset and the forces of both curves act on the shared angle.
 */
export type Constraint = PositionConstraint | OrientationConstraint

/** The whole multi-curve setup authored by the user. */
export interface Setup {
  curves: Curve[]
  /** Links between control points of (possibly different) curves. */
  constraints?: Constraint[]
  /** Nominal length of the line between neighboring interior points, shared by all curves. */
  resolution: number
}

/** Tunable physics / solver constants (exposed under "Advanced"). */
export interface PhysicsConstants {
  /** Bend-minimization force stiffness. */
  kBend: number
  /**
   * Energy drain: the kinetic energy allowance on top of the potential energy
   * is cooled by a fixed schedule, scaled by `exp(-2 * gamma * h)` each step. With 0
   * the allowance stays constant.
   */
  gamma: number
  /** Integration step size. */
  h: number
  /** Threshold for termination: the kinetic energy must be below it and the largest force below its square root. */
  epsilon: number
  /** Consecutive frames with KE and force below epsilon before termination. */
  settleFrames: number
  /** Safety cap on the number of iterations. */
  maxIter: number
}

export const DEFAULT_CONSTANTS: PhysicsConstants = {
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
  /** Total (kinetic + potential) energy at this frame; never higher than in the previous frame unless points were added or removed. */
  energy?: number
  /** Potential energy of the length terms, ½·k·(L - T)² summed over the curves. */
  lengthEnergy?: number
  /** Potential energy of the bend terms, summed over the curves. */
  bendEnergy?: number
  /** Per-curve point polylines (fix points + interior points), in curve order. */
  curves: Vec2[][]
  /**
   * Index of every control point within its curve's polyline, aligned with
   * `curves`. The point count changes as segments shrink and grow, so this is
   * tracked per frame.
   */
  controlIndices: number[][]
}

export interface FrameMeta {
  /** Largest number of points (all curves together) in any frame. */
  maxPoints: number
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
