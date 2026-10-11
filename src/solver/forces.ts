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

/** Compute the reference length L = average of all segment lengths. */
export function computeReferenceLength(lengths: number[]): number {
  let sum = 0
  for (const len of lengths) sum += len
  return sum / lengths.length
}

/** Length equalization force on free point k (1 <= k <= n). */
export function computeLengthForce(
  k: number,
  lengths: number[],
  unitVecs: Vec2[],
  L: number,
  kLen: number,
): Vec2 {
  // F_len(p_k) = kLen * [ (l_k - L)*shat_k - (l_{k-1} - L)*shat_{k-1} ]
  // k is the free point index (1..n), segments are 0..n
  // segment k is p_{k+1} - p_k, segment k-1 is p_k - p_{k-1}

  let force: Vec2 = [0, 0]

  // Contribution from segment k (p_{k+1} - p_k)
  if (lengths[k] >= EPS_STABILIZE) {
    const term = (lengths[k] - L) * kLen
    force = add(force, scale(unitVecs[k], term))
  }

  // Contribution from segment k-1 (p_k - p_{k-1})
  if (lengths[k - 1] >= EPS_STABILIZE) {
    const term = (lengths[k - 1] - L) * kLen
    force = sub(force, scale(unitVecs[k - 1], term))
  }

  return force
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

/** Cap a vector's length at max, preserving direction. */
export function clampMagnitude(v: Vec2, max: number): Vec2 {
  const m = length(v)
  return m > max ? scale(v, max / m) : v
}

/** Compute total acceleration for all free points (indices 1..n). */
export function computeAcceleration(
  pts: Vec2[],
  vel: Vec2[],
  constants: PhysicsConstants,
): Vec2[] {
  const n = pts.length - 2 // number of free points
  const { lengths, unitVecs } = computeSegments(pts)
  const L = computeReferenceLength(lengths)

  const accel: Vec2[] = new Array(pts.length)
  for (let i = 0; i < pts.length; i++) accel[i] = [0, 0]

  for (let k = 1; k <= n; k++) {
    const fLen = computeLengthForce(k, lengths, unitVecs, L, constants.kLen)
    const fFric = computeFrictionForce(vel[k], constants.gamma)
    accel[k] = add(add(accel[k], fLen), fFric)

    // Joint k spans (p_{k-1}, p_k, p_{k+1}); distribute its bend force to the
    // neighboring free points too (anchors 0 and N-1 absorb their share).
    const { prev, cur, next } = computeBendForces(k, lengths, unitVecs, constants.kBend)
    accel[k] = add(accel[k], cur)
    if (k - 1 >= 1) accel[k - 1] = add(accel[k - 1], prev)
    if (k + 1 <= n) accel[k + 1] = add(accel[k + 1], next)
  }

  // Per-free-point force cap — clamp each free point's net acceleration.
  if (Number.isFinite(constants.maxForce)) {
    for (let k = 1; k <= n; k++) accel[k] = clampMagnitude(accel[k], constants.maxForce)
  }

  return accel
}

/** Enforce orientation constraints on first and last free points. */
export function enforceOrientationConstraints(
  pts: Vec2[],
  vel: Vec2[],
  startDir: Vec2,
  endDir: Vec2,
): void {
  const N = pts.length

  // First segment: d0 = normalize(startDir)
  const d0 = normalize(startDir)
  // Project p_1 onto ray from p_0 along d0: p_1 = p_0 + max(((p_1 - p_0)·d0), 0) * d0
  const p1Rel = sub(pts[1], pts[0])
  const proj1 = dot(p1Rel, d0)
  const clampedProj1 = proj1 > 0 ? proj1 : 0
  pts[1] = add(pts[0], scale(d0, clampedProj1))

  // Project velocity: v_1 = (v_1·d0) * d0
  const v1Dot = dot(vel[1], d0)
  vel[1] = scale(d0, v1Dot)

  // Last segment: d1 = normalize(endDir)
  const d1 = normalize(endDir)
  // m = N-2 (index of last free point)
  const m = N - 2
  // Project p_m onto ray: p_m = p_{N-1} - max(((p_{N-1} - p_m)·d1), 0) * d1
  const pmRel = sub(pts[N - 1], pts[m])
  const projM = dot(pmRel, d1)
  const clampedProjM = projM > 0 ? projM : 0
  pts[m] = sub(pts[N - 1], scale(d1, clampedProjM))

  // Project velocity: v_m = (v_m·d1) * d1
  const vmDot = dot(vel[m], d1)
  vel[m] = scale(d1, vmDot)
}

/** Verify all positions, velocities, accelerations are finite. */
export function verifyFinite(pts: Vec2[], vel: Vec2[], accel: Vec2[]): void {
  for (let i = 0; i < pts.length; i++) {
    if (!isFiniteVec2(pts[i]) || !isFiniteVec2(vel[i]) || !isFiniteVec2(accel[i])) {
      throw new Error(`Non-finite value detected at index ${i}: pos=${pts[i]}, vel=${vel[i]}, accel=${accel[i]}`)
    }
  }
}

/** Compute kinetic energy of free points. */
export function computeKineticEnergy(vel: Vec2[]): number {
  let ke = 0
  for (let k = 1; k < vel.length - 1; k++) {
    const v = vel[k]
    ke += v[0] * v[0] + v[1] * v[1]
  }
  return 0.5 * ke
}

/** Deep copy points array. */
export function copyPoints(pts: Vec2[]): Vec2[] {
  return pts.map((p) => [p[0], p[1]])
}