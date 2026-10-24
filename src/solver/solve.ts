import type { Curve, Frame, FrameMeta, FrameSet, PhysicsConstants, Setup, Vec2 } from './types'
import { DEFAULT_CONSTANTS, DEFAULT_FLATNESS } from './types'
import { add, dot, length, normalize, scale, sub } from './forces'
import { validateConstants, validateSetup } from './validate'
import {
  type ChainModel,
  type PointConstraint,
  computeAcceleration,
  computeKineticEnergy,
  computePotentialEnergy,
  enforceConstraints,
  verifyFinite,
} from './forces'
import { createFrameBuffer } from './frameBuffer'
import { planCurve, safeResolution, sampleAlong, unitOrNull } from './curve'
import { equalizeSegments, remesh } from './remesh'
import { resolveSetup, type OrientationGroup } from './constraints'
import { ProgressTracker } from './progress'

/** Thrown by solve() when shouldCancel() returns true. */
export class CancelledError extends Error {
  constructor() {
    super('cancelled')
    this.name = 'CancelledError'
  }
}

export interface SolveOptions {
  onProgress?: (progress: number, iteration: number, ke: number) => void
  shouldCancel?: () => boolean
  /** Uniform [0,1) source for the initial-pose jitter. Math.random by default. */
  random?: () => number
}

/** Initial-pose jitter amplitude, as a fraction of the segment spacing. */
const INIT_JITTER = 0.15

/** How one control point behaves; independent of where it sits in the polyline. */
interface ControlSpec {
  movable: boolean
  dir: Vec2 | null
  collinear: boolean
}

/** One curve as a single polyline with its constraint model. */
interface ChainState {
  pts: Vec2[]
  vel: Vec2[]
  model: ChainModel
  controls: ControlSpec[]
  targetLength: number | null
  weights: Weights
  /** Replaced (never mutated) whenever the point count changes. */
  controlIndices: number[]
}

/** Per-step displacement cap, as a fraction of the resolution; keeps a stiff transient from exploding. */
const MAX_STEP_FRACTION = 0.25

/** Relative tolerance for floating point noise when comparing total energies. */
const ENERGY_SLACK = 1e-12

/** Strength of the pull toward a shorter curve when its flatness is 0.5. */
const SHORTNESS_PULL = 0.1
/** Even a "flattest possible" curve keeps this much pull, so it cannot grow forever. */
const MIN_SHORTNESS_SHARE = 0.02
/** How many times a rejected step is retried with half the step size before the chain is declared at rest. */
const MAX_BACKTRACKS = 24

/** Physics weights of one curve, derived from its flatness and the resolution. */
interface Weights {
  bendWeight: number
  shortness: number
}

function curveWeights(curve: Curve, res: number): Weights {
  const raw = curve.flatness
  const flat = typeof raw === 'number' && Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : DEFAULT_FLATNESS
  return {
    // Bend energy is summed per joint; dividing by the spacing makes it independent of the resolution.
    bendWeight: (2 * flat) / res,
    shortness: 2 * SHORTNESS_PULL * Math.max(1 - flat, MIN_SHORTNESS_SHARE),
  }
}

function buildModel(
  total: number,
  controls: ControlSpec[],
  controlIndices: number[],
  targetLength: number | null,
  weights: Weights,
): ChainModel {
  const movable: boolean[] = new Array(total).fill(true)
  const constraints: PointConstraint[] = []
  controls.forEach((c, j) => {
    const index = controlIndices[j]
    if (!c.movable) movable[index] = false
    if (c.dir) constraints.push({ index, dir: c.dir, collinear: false })
    else if (c.collinear) constraints.push({ index, dir: null, collinear: true })
  })
  return { movable, targetLength, constraints, ...weights }
}

/** Keys ("curve:point") of every point whose tangent is decided by an orientation group. */
function linkedKeys(groups: OrientationGroup[]): Set<string> {
  return new Set(groups.flat().map(({ ref }) => `${ref.curve}:${ref.point}`))
}

const rotateVec = (v: Vec2, angle: number): Vec2 => {
  const c = Math.cos(angle)
  const s = Math.sin(angle)
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c]
}

/**
 * Keeps the tangents of linked points at their angular offsets. Each member
 * reports its current tangent (de-rotated by its offset); the group moves to
 * the mean, so the bending forces of every member's curve act on the shared
 * angle. Each member's neighbors are then rotated about it onto that tangent.
 */
function enforceOrientationGroups(groups: OrientationGroup[], chains: ChainState[]): void {
  for (const group of groups) {
    let sum: Vec2 = [0, 0]
    for (const { ref, angle } of group) {
      const { pts, controlIndices } = chains[ref.curve]
      const i = controlIndices[ref.point]
      let t: Vec2 = [0, 0]
      if (i > 0) t = add(t, normalize(sub(pts[i], pts[i - 1])))
      if (i < pts.length - 1) t = add(t, normalize(sub(pts[i + 1], pts[i])))
      sum = add(sum, rotateVec(normalize(t), -angle))
    }
    const shared = normalize(sum)
    if (length(shared) === 0) continue
    for (const { ref, angle } of group) {
      const { pts, vel, controlIndices } = chains[ref.curve]
      const i = controlIndices[ref.point]
      const d = rotateVec(shared, angle)
      if (i > 0) {
        pts[i - 1] = sub(pts[i], scale(d, length(sub(pts[i], pts[i - 1]))))
        vel[i - 1] = scale(d, dot(vel[i - 1], d))
      }
      if (i < pts.length - 1) {
        pts[i + 1] = add(pts[i], scale(d, length(sub(pts[i + 1], pts[i]))))
        vel[i + 1] = scale(d, dot(vel[i + 1], d))
      }
    }
  }
}

function buildChain(
  curve: Curve,
  resolution: number,
  random: () => number,
  linked: (point: number) => boolean = () => false,
): ChainState {
  const res = safeResolution(resolution)
  const plan = planCurve(curve, res)
  const pts: Vec2[] = []

  plan.spans.forEach((span, si) => {
    const distances: number[] = [0]
    for (const len of span.lengths) distances.push(distances[distances.length - 1] + len)
    distances[distances.length - 1] = span.length
    const sampled = sampleAlong(span.polyline, distances)

    // Perpendicular jitter relative to the chord, away from the span ends.
    const a = curve.fixPoints[si]
    const b = curve.fixPoints[si + 1]
    const dx = b.pos[0] - a.pos[0]
    const dy = b.pos[1] - a.pos[1]
    const chord = Math.hypot(dx, dy)
    if (chord > 1e-3) {
      const perp: Vec2 = [-dy / chord, dx / chord]
      const spacing = span.length / span.segments
      for (let k = 2; k < span.segments - 1; k++) {
        const amp = INIT_JITTER * spacing * (2 * random() - 1)
        sampled[k] = [sampled[k][0] + amp * perp[0], sampled[k][1] + amp * perp[1]]
      }
    }

    const d0 = unitOrNull(a.orientation)
    const d1 = unitOrNull(b.orientation)
    const first = span.lengths[0]
    const lastLen = Math.max(span.lengths[span.segments - 1], 0.3 * first)
    if (d0) sampled[1] = [a.pos[0] + first * d0[0], a.pos[1] + first * d0[1]]
    if (d1) {
      sampled[span.segments - 1] = [b.pos[0] - lastLen * d1[0], b.pos[1] - lastLen * d1[1]]
    }

    const from = si === 0 ? 0 : 1
    for (let k = from; k < sampled.length; k++) pts.push([sampled[k][0], sampled[k][1]])
  })

  const lastControl = curve.fixPoints.length - 1
  const controls: ControlSpec[] = curve.fixPoints.map((fp, j) => {
    const posFree = fp.posFree === true
    const dir = unitOrNull(fp.orientation)
    return {
      movable: posFree,
      dir,
      collinear: !dir && !posFree && !linked(j) && j > 0 && j < lastControl,
    }
  })

  const target = curve.targetLength
  const targetLength = target != null && Number.isFinite(target) && target > 0 ? target : null

  const weights = curveWeights(curve, res)
  const model = buildModel(pts.length, controls, plan.controlIndices, targetLength, weights)
  const vel: Vec2[] = pts.map(() => [0, 0])
  enforceConstraints(pts, vel, model.constraints)
  return { pts, vel, model, controls, targetLength, weights, controlIndices: plan.controlIndices }
}

function totalKineticEnergy(chains: ChainState[]): number {
  let ke = 0
  for (const chain of chains) ke += computeKineticEnergy(chain.vel)
  return ke
}

function totalPotentialEnergy(chains: ChainState[], constants: PhysicsConstants): number {
  let pe = 0
  for (const chain of chains) pe += computePotentialEnergy(chain.pts, constants, chain.model)
  return pe
}

interface Snapshot {
  pts: Vec2[]
  vel: Vec2[]
  model: ChainModel
  controlIndices: number[]
}

const snapshot = (chains: ChainState[]): Snapshot[] =>
  chains.map((c) => ({
    pts: c.pts.map((p): Vec2 => [p[0], p[1]]),
    vel: c.vel.map((v): Vec2 => [v[0], v[1]]),
    model: c.model,
    controlIndices: c.controlIndices,
  }))

function restore(chains: ChainState[], saved: Snapshot[]): void {
  chains.forEach((c, i) => {
    c.pts = saved[i].pts.map((p): Vec2 => [p[0], p[1]])
    c.vel = saved[i].vel.map((v): Vec2 => [v[0], v[1]])
    c.model = saved[i].model
    c.controlIndices = saved[i].controlIndices
  })
}

function scaleVelocities(chains: ChainState[], factor: number): void {
  for (const chain of chains) {
    for (const v of chain.vel) {
      v[0] *= factor
      v[1] *= factor
    }
  }
}

/**
 * Report progress with ~50ms throttling. The final sample (via `finalize`)
 * always reports 1.0 together with the true last iteration and energy, so the
 * UI never flashes the configured maxIter as if the run had used it all.
 */
function makeProgressReporter(
  onProgress: SolveOptions['onProgress'],
  maxIter: number,
  release: number,
): {
  report: (iteration: number, ke: number, force?: boolean) => void
  finalize: (iteration: number, ke: number) => void
} {
  const tracker = new ProgressTracker(release)
  let lastReportTime = 0
  let hasReported = false

  const report = (iteration: number, ke: number, force = false): void => {
    if (!onProgress) return
    tracker.observe(ke)
    const now = performance.now()
    if (!force && hasReported && now - lastReportTime < 50) return
    onProgress(tracker.progress(iteration, maxIter), iteration, ke)
    lastReportTime = now
    hasReported = true
  }

  const finalize = (iteration: number, ke: number): void => {
    if (onProgress) onProgress(1, iteration, ke)
  }

  return { report, finalize }
}

export function solve(
  authored: Setup,
  constants: PhysicsConstants = DEFAULT_CONSTANTS,
  options: SolveOptions = {},
): FrameSet {
  const issues = validateSetup(authored)
  if (issues.length > 0) {
    throw new Error(`Invalid setup: ${issues.map((i) => i.message).join('; ')}`)
  }
  const constantsIssue = validateConstants(constants)
  if (constantsIssue) throw new Error(constantsIssue)
  const { setup, positionGroups, orientationGroups } = resolveSetup(authored)

  const { onProgress, shouldCancel, random = Math.random } = options
  const { h, gamma, epsilon, settleFrames, maxIter } = constants

  const linked = linkedKeys(orientationGroups)
  const chains = setup.curves.map((curve, ci) =>
    buildChain(curve, setup.resolution, random, (pi) => linked.has(`${ci}:${pi}`)),
  )
  enforceOrientationGroups(orientationGroups, chains)
  const res = safeResolution(setup.resolution)
  const maxStep = MAX_STEP_FRACTION * res
  const countPoints = (): number => chains.reduce((sum, chain) => sum + chain.pts.length, 0)
  let maxPoints = countPoints()

  const captureCurves = (): Vec2[][] => chains.map((chain) => chain.pts.map((p): Vec2 => [p[0], p[1]]))
  const captureControls = (): number[][] => chains.map((chain) => chain.controlIndices)

  // One integration step plus the kinematic projections. `damp` drains
  // velocity (the only dissipation); everything else is conservative.
  const advance = (dt: number, damp: number): void => {
    for (const chain of chains) {
      const { pts, vel, model } = chain
      const accel = computeAcceleration(pts, constants, model)
      verifyFinite(pts, vel, accel)

      for (let k = 0; k < pts.length; k++) {
        if (!model.movable[k]) continue
        vel[k][0] = vel[k][0] * damp + dt * accel[k][0]
        vel[k][1] = vel[k][1] * damp + dt * accel[k][1]
        const step = dt * Math.hypot(vel[k][0], vel[k][1])
        if (step > maxStep) {
          vel[k][0] *= maxStep / step
          vel[k][1] *= maxStep / step
        }
        pts[k][0] += dt * vel[k][0]
        pts[k][1] += dt * vel[k][1]
      }
    }

    // Points tied by a position constraint move as one: share their mean state.
    for (const group of positionGroups) {
      const members = group.map(({ ref, offset }) => ({
        chain: chains[ref.curve],
        idx: chains[ref.curve].controlIndices[ref.point],
        offset,
      }))
      let px = 0, py = 0, vx = 0, vy = 0
      for (const { chain, idx, offset } of members) {
        px += chain.pts[idx][0] - offset[0]; py += chain.pts[idx][1] - offset[1]
        vx += chain.vel[idx][0]; vy += chain.vel[idx][1]
      }
      const n = members.length
      for (const { chain, idx, offset } of members) {
        chain.pts[idx][0] = px / n + offset[0]; chain.pts[idx][1] = py / n + offset[1]
        chain.vel[idx][0] = vx / n; chain.vel[idx][1] = vy / n
      }
    }

    for (const chain of chains) {
      const indices = remesh(chain.pts, chain.vel, chain.controlIndices, res)
      if (indices !== chain.controlIndices) {
        chain.controlIndices = indices
        chain.model = buildModel(chain.pts.length, chain.controls, indices, chain.targetLength, chain.weights)
      }
      equalizeSegments(chain.pts, chain.vel, chain.controlIndices)
      enforceConstraints(chain.pts, chain.vel, chain.model.constraints)
    }
    enforceOrientationGroups(orientationGroups, chains)
    for (const chain of chains) verifyFinite(chain.pts, chain.vel, chain.vel)
  }

  const buffer = createFrameBuffer()
  const initialKe = totalKineticEnergy(chains)
  let energy = totalPotentialEnergy(chains, constants) + initialKe
  buffer.add({ i: 0, ke: initialKe, energy, curves: captureCurves(), controlIndices: captureControls() })

  // Settle the pose onto the projections so the energy baseline of the first step is reachable.
  for (let k = 0; k < 3; k++) advance(0, 1)
  energy = totalPotentialEnergy(chains, constants) + totalKineticEnergy(chains)
  maxPoints = Math.max(maxPoints, countPoints())

  const { report, finalize } = makeProgressReporter(
    onProgress,
    maxIter,
    constants.gamma * constants.h,
  )
  report(0, initialKe, true)

  let termination: 'ke' | 'maxIter' = 'maxIter'
  let settleStreak = 0
  let lastIter = 0
  let lastKe = initialKe

  for (let i = 1; i <= maxIter; i++) {
    if (shouldCancel?.()) {
      throw new CancelledError()
    }

    // Total energy may never rise. A step that would raise it first loses the
    // excess kinetic energy; if even zero velocity is not enough, the step is
    // retried with a smaller size, and finally the chains simply stay at rest.
    const before = snapshot(chains)
    const pointsBefore = countPoints()
    let dt = h
    let accepted = false
    for (let attempt = 0; attempt <= MAX_BACKTRACKS && !accepted; attempt++) {
      if (attempt > 0) {
        restore(chains, before)
        dt /= 2
        if (attempt > 3) for (const chain of chains) for (const v of chain.vel) { v[0] = 0; v[1] = 0 }
      }
      advance(dt, 1 - Math.min(1, gamma * dt))
      if (countPoints() !== pointsBefore) {
        // Points were added or removed: the energies of the two discretizations are not comparable.
        accepted = true
        break
      }
      const pe = totalPotentialEnergy(chains, constants)
      const kinetic = totalKineticEnergy(chains)
      const budget = energy - pe
      if (kinetic <= budget + ENERGY_SLACK * Math.max(1, Math.abs(energy))) accepted = true
      else if (budget >= 0) {
        scaleVelocities(chains, Math.sqrt(budget / kinetic))
        accepted = true
      }
    }
    if (!accepted) {
      // At rest: only the projections may still nudge the pose, which re-baselines the energy.
      restore(chains, before)
      for (const chain of chains) for (const v of chain.vel) { v[0] = 0; v[1] = 0 }
      advance(0, 1)
    }
    maxPoints = Math.max(maxPoints, countPoints())
    energy = totalPotentialEnergy(chains, constants) + totalKineticEnergy(chains)

    const ke = totalKineticEnergy(chains)
    if (ke < epsilon) settleStreak += 1
    else settleStreak = 0

    buffer.add({ i, ke, energy, curves: captureCurves(), controlIndices: captureControls() })
    lastIter = i
    lastKe = ke

    report(i, ke)

    if (settleStreak >= settleFrames) {
      termination = 'ke'
      break
    }
    if (i >= maxIter) {
      termination = 'maxIter'
      break
    }
  }

  finalize(lastIter, lastKe)

  const last: Frame = { i: lastIter, ke: lastKe, energy, curves: captureCurves(), controlIndices: captureControls() }
  const frames = buffer.finish(last)

  const meta: FrameMeta = {
    maxPoints,
    curveCount: chains.length,
    input: setup,
    constants,
    termination,
    frameCount: frames.length,
    iterations: lastIter,
  }

  return {
    version: 1,
    meta,
    frames,
  }
}

export interface PreviewLayout {
  /** Initial polyline of every curve. */
  curves: Vec2[][]
  /** Control point indices into each polyline (always consistent with `curves`). */
  controlIndices: number[][]
}

const EMPTY_LAYOUT: PreviewLayout = { curves: [], controlIndices: [] }

/**
 * Deterministic (no-jitter) initial layout for the editor preview. Never
 * throws: a setup that cannot be laid out yields an empty layout, so editing
 * half-typed values can not take the UI down.
 */
export function previewLayout(authored: Setup): PreviewLayout {
  try {
    const { setup, orientationGroups } = resolveSetup(authored)
    const linked = linkedKeys(orientationGroups)
    const chains = setup.curves.map((curve, ci) =>
      buildChain(curve, setup.resolution, () => 0.5, (pi) => linked.has(`${ci}:${pi}`)),
    )
    enforceOrientationGroups(orientationGroups, chains)
    const finite = chains.every((c) => c.pts.every((p) => Number.isFinite(p[0]) && Number.isFinite(p[1])))
    if (!finite) return EMPTY_LAYOUT
    return { curves: chains.map((c) => c.pts), controlIndices: chains.map((c) => c.controlIndices) }
  } catch {
    return EMPTY_LAYOUT
  }
}

/** Initial polylines only; see {@link previewLayout}. */
export function previewPose(authored: Setup): Vec2[][] {
  return previewLayout(authored).curves
}
