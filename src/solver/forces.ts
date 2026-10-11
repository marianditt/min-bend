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

/** Bend minimization force on free point k (1 <= k <= n). */
export function computeBendForce(
  k: number,
  pts: Vec2[],
  unitVecs: Vec2[],
  kBend: number,
): Vec2 {
  // dA = shat_{k-1}, dB = shat_k
  const dA = unitVecs[k - 1]
  const dB = unitVecs[k]

  // cosTheta = dA·dB, clamped to [-1, 1]
  let cosTheta = dot(dA, dB)
  if (cosTheta > 1) cosTheta = 1
  else if (cosTheta < -1) cosTheta = -1

  // magnitude m = kBend * (1 - cosTheta)
  const m = kBend * (1 - cosTheta)
  if (m === 0) return [0, 0]

  // c = p_{k+1} - p_{k-1} (chord)
  const c = sub(pts[k + 1], pts[k - 1])
  const cLen = length(c)
  if (cLen < EPS_STABILIZE) return [0, 0]

  const chat = scale(c, 1 / cLen)

  // delta = cross(chat, p_k - p_{k-1})
  const pkMinusPk_1 = sub(pts[k], pts[k - 1])
  const delta = cross(chat, pkMinusPk_1)

  // nhat = -sign(delta) * perp(chat)
  const signDelta = delta > 0 ? 1 : delta < 0 ? -1 : 0
  if (signDelta === 0) return [0, 0]

  const nhat = scale(perp(chat), -signDelta)

  // F_bend = m * nhat
  return scale(nhat, m)
}

/** Friction force on free point k. */
export function computeFrictionForce(vel: Vec2, gamma: number): Vec2 {
  return scale(vel, -gamma)
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
  // Fixed points have zero acceleration
  accel[0] = [0, 0]
  accel[pts.length - 1] = [0, 0]

  for (let k = 1; k <= n; k++) {
    const fLen = computeLengthForce(k, lengths, unitVecs, L, constants.kLen)
    const fBend = computeBendForce(k, pts, unitVecs, constants.kBend)
    const fFric = computeFrictionForce(vel[k], constants.gamma)

    accel[k] = add(add(fLen, fBend), fFric)
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