// Shared contract for the min-bend solver and renderer.
// FROZEN: both the solver and the UI are built against these types.
// Extend only additively (new optional fields). muteFrames was renamed to settleFrames when the KE gate became a consecutive-quiet-frame gate.

export type Vec2 = [number, number]

/** User-provided problem definition from the sidebar. */
export interface ProblemInput {
  /** Number of free interior points. Total points N = n + 2, segments = n + 1. */
  n: number
  /** Fixed start point p_0. */
  start: Vec2
  /** Fixed end point p_{N-1}. */
  end: Vec2
  /** Direction of the first segment (p_1 - p_0). Normalized by the solver. */
  startDir: Vec2
  /** Direction of the last segment (p_{N-1} - p_{N-2}). Normalized by the solver. */
  endDir: Vec2
  /** Interior points the user drew in the setup editor, in order (length k, 1..n).
   *  When present, the solver seeds p_1..p_k from these and fills the rest linearly. */
  drawnPts?: Vec2[]
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
  /** All N points, fixed endpoints included, in order p_0 .. p_{N-1}. */
  pts: Vec2[]
}

export interface FrameMeta {
  n: number
  N: number
  input: ProblemInput
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
