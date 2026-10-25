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
 * Straightening force on point k, from the bend at that point only. It acts
 * perpendicular to the point's tangent (the average of the incoming and outgoing directions), toward the midpoint of its neighbors (lower bend), and
 * its magnitude is stiffness times the turning angle.
 * {@link computeAcceleration} balances it with half the opposite force on each
 * neighbor, so the bend adds no net force (a one-sided force pumps energy in).
 */
export function computeBendForce(
  k: number,
  pts: Vec2[],
  lengths: number[],
  unitVecs: Vec2[],
  stiffness: number,
): Vec2 {
  if (lengths[k - 1] < EPS_STABILIZE || lengths[k] < EPS_STABILIZE) return [0, 0]
  const t0 = unitVecs[k - 1]
  const t1 = unitVecs[k]
  const theta = Math.acos(Math.max(-1, Math.min(1, dot(t0, t1))))
  if (theta === 0) return [0, 0]
  const tangent = normalize(add(t0, t1))
  const toMid = sub(scale(add(pts[k - 1], pts[k + 1]), 0.5), pts[k])
  const normal = normalize(sub(toMid, scale(tangent, dot(toMid, tangent))))
  return scale(normal, stiffness * theta)
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
   * Stiffness k of the length energy ½·k·(L − T)²/n (n = segment count), so the
   * correction is shared evenly by all segments. T is the target length or, when
   * the length is free, the shortest possible length (see {@link restLength}).
   * 0 disables the length force.
   */
  lengthStiffness?: number
  /** Mass per point (default 1): heavier control points settle more slowly than the interior points between them. */
  mass?: number[]
}

/** Stiffness of the length force of a chain with a target length, per resolution unit. */
export const LENGTH_STIFFNESS = 20

function totalLength(lengths: number[]): number {
  let total = 0
  for (const len of lengths) total += len
  return total
}

/**
 * The length the chain strives for: its target length, or else the shortest
 * possible one, a polyline through the pinned points (0 with fewer than two).
 */
export function restLength(pts: Vec2[], model: ChainModel): number {
  if (model.targetLength != null) return model.targetLength
  let total = 0
  let prev: Vec2 | null = null
  for (let i = 0; i < pts.length; i++) {
    if (model.movable[i]) continue
    if (prev) total += length(sub(pts[i], prev))
    prev = pts[i]
  }
  return total
}

/** Tension of every segment: the overall length error shared among the segments. */
function lengthTension(pts: Vec2[], lengths: number[], model: ChainModel): number {
  const n = lengths.length
  if (n === 0) return 0
  return ((model.lengthStiffness ?? 0) * (totalLength(lengths) - restLength(pts, model))) / n
}

/** The two parts of a chain's potential energy, tracked separately. */
export interface EnergyParts {
  length: number
  bend: number
}

/**
 * Energy of a chain: the length energy ½·k·(L - T)²/n, whose gradient is the length
 * force, plus ½·stiffness·θ² per joint as a measure of the bend (the bend force
 * acts locally and is not its exact gradient).
 */
export function computeEnergyParts(pts: Vec2[], model: ChainModel): EnergyParts {
  const { lengths, unitVecs } = computeSegments(pts)
  const stiffness = model.bendStiffness ?? 1
  let bend = 0
  for (let j = 1; j < pts.length - 1; j++) {
    if (lengths[j - 1] < EPS_STABILIZE || lengths[j] < EPS_STABILIZE) continue
    const theta = Math.acos(Math.max(-1, Math.min(1, dot(unitVecs[j - 1], unitVecs[j]))))
    bend += theta * theta
  }
  const delta = totalLength(lengths) - restLength(pts, model)
  const n = Math.max(1, lengths.length)
  return { bend: 0.5 * stiffness * bend, length: (0.5 * (model.lengthStiffness ?? 0) * delta * delta) / n }
}

export function computePotentialEnergy(pts: Vec2[], model: ChainModel): number {
  const { length, bend } = computeEnergyParts(pts, model)
  return length + bend
}

/**
 * Acceleration of every movable point of a chain: the local straightening force
 * plus the length force, divided by the point's mass.
 * Friction is applied by the integrator.
 */
export function computeAcceleration(
  pts: Vec2[],
  model: ChainModel,
): Vec2[] {
  const last = pts.length - 1
  const { lengths, unitVecs } = computeSegments(pts)
  const tension = lengthTension(pts, lengths, model)
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
    const f = computeBendForce(j, pts, lengths, unitVecs, stiffness)
    if (model.movable[j]) force[j] = add(force[j], f)
    if (model.movable[j - 1]) force[j - 1] = sub(force[j - 1], scale(f, 0.5))
    if (model.movable[j + 1]) force[j + 1] = sub(force[j + 1], scale(f, 0.5))
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