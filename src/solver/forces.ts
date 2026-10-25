import { EPS_STABILIZE, type Vec2 } from './types'

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
 *   E_k = stiffness * (1 - shat_{k-1}·shat_k)
 * with respect to each joint point, so the forces sum to zero:
 *   F_prev = stiffness * (c*t0 - t1) / l0     (force on p_{k-1})
 *   F_next = stiffness * (t0 - c*t1) / l1     (force on p_{k+1})
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
  stiffness: number,
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

  const prev = scale(sub(scale(t0, c), t1), stiffness / l0)
  const next = scale(sub(t0, scale(t1, c)), stiffness / l1)
  const cur = scale(add(prev, next), -1)

  return { prev, cur, next }
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
  /** Bend stiffness of this chain (default 1). */
  bendStiffness?: number
  /**
   * Stiffness k of the length energy ½·k·(L − T)², where T is the target
   * length, or 0 when the length is free (default 0 = no length energy).
   */
  lengthStiffness?: number
  /** Mass per point (default 1): heavier control points settle more slowly than the interior points between them. */
  mass?: number[]
}

/** Stiffness of the length energy of a chain with a target length. */
export const LENGTH_STIFFNESS = 20

function totalLength(lengths: number[]): number {
  let total = 0
  for (const len of lengths) total += len
  return total
}

/** Tension along the whole chain: the derivative of the length energy with respect to the length. */
function lengthTension(lengths: number[], model: ChainModel): number {
  return (model.lengthStiffness ?? 0) * (totalLength(lengths) - (model.targetLength ?? 0))
}

/** The two parts of a chain's potential energy, tracked separately. */
export interface EnergyParts {
  length: number
  bend: number
}

/**
 * Potential energy of a chain: bend energy stiffness * (1 - cos) summed over every
 * joint, plus the length energy ½·k·(L - T)² (T = 0 when the length is free).
 * Their gradients are the forces used by {@link computeAcceleration}.
 */
export function computeEnergyParts(pts: Vec2[], model: ChainModel): EnergyParts {
  const { lengths, unitVecs } = computeSegments(pts)
  const stiffness = model.bendStiffness ?? 1
  let bend = 0
  for (let j = 1; j < pts.length - 1; j++) {
    if (lengths[j - 1] < EPS_STABILIZE || lengths[j] < EPS_STABILIZE) continue
    bend += 1 - Math.max(-1, Math.min(1, dot(unitVecs[j - 1], unitVecs[j])))
  }
  const delta = totalLength(lengths) - (model.targetLength ?? 0)
  return { bend: stiffness * bend, length: 0.5 * (model.lengthStiffness ?? 0) * delta * delta }
}

export function computePotentialEnergy(pts: Vec2[], model: ChainModel): number {
  const { length, bend } = computeEnergyParts(pts, model)
  return length + bend
}

/**
 * Acceleration of every movable point of a chain: the bend-minimizing force
 * plus the length-error-minimizing force, divided by the point's mass.
 * Friction is applied by the integrator.
 */
export function computeAcceleration(
  pts: Vec2[],
  model: ChainModel,
): Vec2[] {
  const last = pts.length - 1
  const { lengths, unitVecs } = computeSegments(pts)
  const tension = lengthTension(lengths, model)
  const stiffness = model.bendStiffness ?? 1
  const massOf = (i: number): number => model.mass?.[i] ?? 1

  const force: Vec2[] = new Array(pts.length)
  for (let i = 0; i <= last; i++) force[i] = [0, 0]

  for (let i = 0; i <= last; i++) {
    if (!model.movable[i] || tension === 0) continue
    if (i < last) force[i] = add(force[i], scale(unitVecs[i], tension))
    if (i > 0) force[i] = sub(force[i], scale(unitVecs[i - 1], tension))
  }

  for (let j = 1; j < last; j++) {
    const { prev, cur, next } = computeBendForces(j, lengths, unitVecs, stiffness)
    if (model.movable[j - 1]) force[j - 1] = add(force[j - 1], prev)
    if (model.movable[j]) force[j] = add(force[j], cur)
    if (model.movable[j + 1]) force[j + 1] = add(force[j + 1], next)
  }

  const accel: Vec2[] = force.map((f, i) => scale(f, 1 / massOf(i)))

  // A movable control point with a fixed tangent drags its two neighbors
  // along (they are slaved to its tangent line), so the three move as one
  // body: their perpendicular forces are pooled and divided by the total mass.
  for (const c of model.constraints) {
    if (!c.dir || !model.movable[c.index]) continue
    const d = c.dir
    const members = [c.index]
    if (c.index > 0) members.push(c.index - 1)
    if (c.index < last) members.push(c.index + 1)
    let perpSum: Vec2 = [0, 0]
    let massSum = 0
    for (const m of members) {
      perpSum = add(perpSum, sub(force[m], scale(d, dot(force[m], d))))
      massSum += massOf(m)
    }
    accel[c.index] = add(scale(d, dot(accel[c.index], d)), scale(perpSum, 1 / massSum))
  }

  return accel
}

/** A neighbor that ends up on the wrong side of its tangent keeps a fraction of its distance instead of collapsing onto the point, which would hide its bend energy. */
const WRONG_SIDE_KEEP = 0.3

function alongOrFloor(seg: Vec2, d: Vec2): number {
  const along = dot(seg, d)
  return along > 0 ? along : WRONG_SIDE_KEEP * length(seg)
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
        const proj = alongOrFloor(sub(pts[i], pts[i - 1]), d)
        pts[i - 1] = sub(pts[i], scale(d, proj))
        vel[i - 1] = scale(d, dot(vel[i - 1], d))
      }
      if (i < last) {
        const proj = alongOrFloor(sub(pts[i + 1], pts[i]), d)
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
export function computeKineticEnergy(vel: Vec2[], mass?: number[]): number {
  let ke = 0
  vel.forEach((v, i) => {
    ke += (mass?.[i] ?? 1) * (v[0] * v[0] + v[1] * v[1])
  })
  return 0.5 * ke
}

/** Deep copy points array. */
export function copyPoints(pts: Vec2[]): Vec2[] {
  return pts.map((p) => [p[0], p[1]])
}