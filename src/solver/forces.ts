import { EPS_STABILIZE, type PhysicsConstants, type Vec2 } from './types'

/** 2D vector operations */
export function add(a: Vec2, b: Vec2): Vec2 {
  return [a[0] + b[0], a[1] + b[1]]
}

export function sub(a: Vec2, b: Vec2): Vec2 {
  return [a[0] - b[0], a[1] - b[1]]
}

export function scale(v: Vec2, s: number): Vec2 {
  return [v[0] * s, v[1] * s]
}

export function dot(a: Vec2, b: Vec2): number {
  return a[0] * b[0] + a[1] * b[1]
}

export function cross(a: Vec2, b: Vec2): number {
  return a[0] * b[1] - a[1] * b[0]
}

export function perp(v: Vec2): Vec2 {
  return [-v[1], v[0]]
}

export function length(v: Vec2): number {
  return Math.hypot(v[0], v[1])
}

export function normalize(v: Vec2): Vec2 {
  const len = length(v)
  if (len < EPS_STABILIZE) return [0, 0]
  return [v[0] / len, v[1] / len]
}

export function isFiniteVec2(v: Vec2): boolean {
  return Number.isFinite(v[0]) && Number.isFinite(v[1])
}

/** Compute segment vectors, lengths, and unit vectors for all segments. */
export function computeSegments(pts: Vec2[]): {
  segments: Vec2[]
  lengths: number[]
  unitVecs: Vec2[]
} {
  const nSegments = pts.length - 1
  const segments: Vec2[] = new Array(nSegments)
  const lengths: number[] = new Array(nSegments)
  const unitVecs: Vec2[] = new Array(nSegments)

  for (let k = 0; k < nSegments; k++) {
    const seg = sub(pts[k + 1], pts[k])
    segments[k] = seg
    const len = length(seg)
    lengths[k] = len
    unitVecs[k] = len < EPS_STABILIZE ? [0, 0] : scale(seg, 1 / len)
  }

  return { segments, lengths, unitVecs }
}

/**
 * Symmetric bend forces for the joint at free point k (triple p_{k-1}, p_k, p_{k+1}).
 *
 * These are the negative gradient of the discrete bend energy
 *   E_k = kBend * (1 - shat_{k-1}·shat_k)
 * with respect to each joint point, so the forces sum to zero:
 *   F_prev = kBend * (c*t0 - t1) / l0     (force on p_{k-1})
 *   F_next = kBend * (t0 - c*t1) / l1     (force on p_{k+1})
 *   F_cur  = -(F_prev + F_next)           (force on p_k)
 * where t0/t1 are the segment unit vectors and c = t0·t1.
 *
 * Unlike a force applied only to the middle point, this distributes each joint's
 * bend out to its free neighbors, so a constrained end joint can pull the
 * interior off a straight line instead of collapsing toward the anchor.
 */
export function computeBendForces(
  k: number,
  lengths: number[],
  unitVecs: Vec2[],
  kBend: number,
): { prev: Vec2; cur: Vec2; next: Vec2 } {
  const l0 = lengths[k - 1]
  const l1 = lengths[k]
  if (l0 < EPS_STABILIZE || l1 < EPS_STABILIZE) {
    return { prev: [0, 0], cur: [0, 0], next: [0, 0] }
  }

  const t0 = unitVecs[k - 1]
  const t1 = unitVecs[k]
  let c = dot(t0, t1)
  if (c > 1) c = 1
  else if (c < -1) c = -1

  const prev = scale(sub(scale(t0, c), t1), kBend / l0)
  const next = scale(sub(t0, scale(t1, c)), kBend / l1)
  const cur = scale(add(prev, next), -1)

  return { prev, cur, next }
}

/** Friction force on free point k. */
export function computeFrictionForce(vel: Vec2, gamma: number): Vec2 {
  return scale(vel, -gamma)
}

/** A constraint attached to one control point of a chain. */
export interface PointConstraint {
  /** Index of the control point within the chain. */
  index: number
  /** Fixed unit tangent, or null. */
  dir: Vec2 | null
  /** Incoming and outgoing segments must be collinear (free orientation, fixed position). */
  collinear: boolean
}

/** Per-chain data the force and constraint routines need. */
export interface ChainModel {
  /** Whether each point is integrated (false = pinned). */
  movable: boolean[]
  /** Target total path length of the chain, or null when its length is free. */
  targetLength: number | null
  constraints: PointConstraint[]
}

/**
 * Stiffness of the whole-curve length constraint. The resulting tension is the
 * same on every segment: segments are free to shrink and grow, only the sum is
 * pulled toward the target.
 */
export const LENGTH_STIFFNESS = 20

/** Total acceleration of every movable point of a chain (mass = 1). */
export function computeAcceleration(
  pts: Vec2[],
  vel: Vec2[],
  constants: PhysicsConstants,
  model: ChainModel,
): Vec2[] {
  const last = pts.length - 1
  const { lengths, unitVecs } = computeSegments(pts)
  let tension = 0
  if (model.targetLength !== null) {
    let total = 0
    for (const len of lengths) total += len
    tension = (total - model.targetLength) * LENGTH_STIFFNESS
  }

  const accel: Vec2[] = new Array(pts.length)
  for (let i = 0; i <= last; i++) accel[i] = [0, 0]

  for (let i = 0; i <= last; i++) {
    if (!model.movable[i]) continue
    let force: Vec2 = computeFrictionForce(vel[i], constants.gamma)
    if (tension !== 0) {
      if (i < last) force = add(force, scale(unitVecs[i], tension))
      if (i > 0) force = sub(force, scale(unitVecs[i - 1], tension))
    }
    accel[i] = force
  }

  for (let j = 1; j < last; j++) {
    const { prev, cur, next } = computeBendForces(j, lengths, unitVecs, constants.kBend)
    if (model.movable[j - 1]) accel[j - 1] = add(accel[j - 1], prev)
    if (model.movable[j]) accel[j] = add(accel[j], cur)
    if (model.movable[j + 1]) accel[j + 1] = add(accel[j + 1], next)
  }

  // A movable control point with a fixed tangent drags its two neighbors
  // along (they are slaved to its tangent line), so their perpendicular
  // accelerations are pooled onto it instead of being lost to the projection.
  for (const c of model.constraints) {
    if (!c.dir || !model.movable[c.index]) continue
    const d = c.dir
    const members = [c.index]
    if (c.index > 0) members.push(c.index - 1)
    if (c.index < last) members.push(c.index + 1)
    let perpSum: Vec2 = [0, 0]
    for (const m of members) perpSum = add(perpSum, sub(accel[m], scale(d, dot(accel[m], d))))
    const own = accel[c.index]
    accel[c.index] = add(scale(d, dot(own, d)), scale(perpSum, 1 / members.length))
  }

  return accel
}

/**
 * Enforce control-point constraints by projection:
 *  - fixed orientation d: both neighbors lie on the line through the point
 *    along d (previous behind it, next ahead of it);
 *  - collinear: both neighbors are rotated about the point onto their mean
 *    direction, keeping their distances, so the incoming and outgoing segment
 *    directions are identical (dot product 1) while the angle stays free.
 */
export function enforceConstraints(pts: Vec2[], vel: Vec2[], constraints: PointConstraint[]): void {
  const last = pts.length - 1
  for (const c of constraints) {
    const i = c.index
    if (c.dir) {
      const d = c.dir
      if (i > 0) {
        const proj = Math.max(dot(sub(pts[i], pts[i - 1]), d), 0)
        pts[i - 1] = sub(pts[i], scale(d, proj))
        vel[i - 1] = scale(d, dot(vel[i - 1], d))
      }
      if (i < last) {
        const proj = Math.max(dot(sub(pts[i + 1], pts[i]), d), 0)
        pts[i + 1] = add(pts[i], scale(d, proj))
        vel[i + 1] = scale(d, dot(vel[i + 1], d))
      }
    } else if (c.collinear && i > 0 && i < last) {
      const in_ = sub(pts[i], pts[i - 1])
      const out = sub(pts[i + 1], pts[i])
      const l0 = length(in_)
      const l1 = length(out)
      const t0 = normalize(in_)
      const t1 = normalize(out)
      let d = normalize(add(t0, t1))
      if (length(d) === 0) d = length(t1) > 0 ? t1 : t0
      if (length(d) === 0) continue
      pts[i - 1] = sub(pts[i], scale(d, l0))
      pts[i + 1] = add(pts[i], scale(d, l1))
    }
  }
}

/** Verify all positions, velocities, accelerations are finite. */
export function verifyFinite(pts: Vec2[], vel: Vec2[], accel: Vec2[]): void {
  for (let i = 0; i < pts.length; i++) {
    if (!isFiniteVec2(pts[i]) || !isFiniteVec2(vel[i]) || !isFiniteVec2(accel[i])) {
      throw new Error(`Non-finite value detected at index ${i}: pos=${pts[i]}, vel=${vel[i]}, accel=${accel[i]}`)
    }
  }
}

/** Compute kinetic energy (pinned points have zero velocity). */
export function computeKineticEnergy(vel: Vec2[]): number {
  let ke = 0
  for (const v of vel) {
    ke += v[0] * v[0] + v[1] * v[1]
  }
  return 0.5 * ke
}

/** Deep copy points array. */
export function copyPoints(pts: Vec2[]): Vec2[] {
  return pts.map((p) => [p[0], p[1]])
}