// Shared contract for the min-bend solver and renderer.
// FROZEN: both the solver and the UI are built against these types.
// Extend only additively (new optional fields), never rename/remove.

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
  /** Number of opening frames during which the KE termination gate is muted. */
  muteFrames: number
  /** Safety cap on the number of iterations. */
  maxIter: number
}

export const DEFAULT_CONSTANTS: PhysicsConstants = {
  kLen: 1,
  kBend: 1,
  gamma: 0.1,
  h: 0.01,
  epsilon: 1e-4,
  muteFrames: 10,
  maxIter: 20000,
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
  frameCount: number
}

/** Versioned, extensible result container. */
export interface FrameSet {
  version: 1
  meta: FrameMeta
  frames: Frame[]
}
