import type { Curve, Frame, FrameMeta, FrameSet, PhysicsConstants, Setup, Vec2 } from './types'
import { DEFAULT_CONSTANTS, DEFAULT_FLATNESS } from './types'
import { add, dot, length, normalize, scale, sub } from './forces'
import { validateConstants, validateSetup } from './validate'
import {
  type ChainModel,
  type PointConstraint,
  LENGTH_STIFFNESS,
  computeAcceleration,
  computeEnergyParts,
  type EnergyParts,
  computeKineticEnergy,
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
}

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

/** Strength of the pull toward a shorter curve when its flatness is 0.5. */
const SHORTNESS_PULL = 0.1
/** Even a "flattest possible" curve keeps this much pull, so it cannot grow forever. */
const MIN_SHORTNESS_SHARE = 0.02
/** Bisection steps used to match the step size to the energy budget. */
const BISECTIONS = 18
/** Largest number of halvings/doublings while bracketing the step size. */
const MAX_BRACKET_STEPS = 40

/** Physics weights of one curve, derived from its flatness, length constraint and the resolution. */
interface Weights {
  bendWeight: number
  lengthStiffness: number
}

/**
 * `reference` is the curve's initial length. A free curve's length energy
 * ½·k·L² is scaled by it, so that its tension at the initial length equals a
 * resolution-independent pull.
 */
function curveWeights(curve: Curve, res: number, reference: number, hasTarget: boolean): Weights {
  const raw = curve.flatness
  const flat = typeof raw === 'number' && Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : DEFAULT_FLATNESS
  return {
    // Bend energy is summed per joint; dividing by the spacing makes it independent of the resolution.
    bendWeight: (2 * flat) / res,
    lengthStiffness: hasTarget
      ? LENGTH_STIFFNESS
      : (2 * SHORTNESS_PULL * Math.max(1 - flat, MIN_SHORTNESS_SHARE)) / Math.max(reference, res),
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

    const a = curve.fixPoints[si]
    const b = curve.fixPoints[si + 1]

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

  const reference = plan.spans.reduce((sum, span) => sum + span.length, 0)
  const weights = curveWeights(curve, res, reference, targetLength !== null)
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

function potentialParts(chains: ChainState[], constants: PhysicsConstants): EnergyParts {
  const parts: EnergyParts = { length: 0, bend: 0 }
  for (const chain of chains) {
    const p = computeEnergyParts(chain.pts, constants, chain.model)
    parts.length += p.length
    parts.bend += p.bend
  }
  return parts
}

function totalPotentialEnergy(chains: ChainState[], constants: PhysicsConstants): number {
  const { length, bend } = potentialParts(chains, constants)
  return length + bend
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
  let shown = 0

  const report = (iteration: number, ke: number, force = false): void => {
    if (!onProgress) return
    tracker.observe(ke)
    const now = performance.now()
    if (!force && hasReported && now - lastReportTime < 50) return
    // Kinetic energy can rise again while energy converts back and forth; the bar must not run backwards.
    shown = Math.max(shown, tracker.progress(iteration, maxIter))
    onProgress(shown, iteration, ke)
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

  const { onProgress, shouldCancel } = options
  const { h, epsilon, settleFrames, maxIter } = constants
  const forceEpsilon = Math.sqrt(epsilon) // energy scales with the square of the force scale

  const linked = linkedKeys(orientationGroups)
  const chains = setup.curves.map((curve, ci) =>
    buildChain(curve, setup.resolution, (pi) => linked.has(`${ci}:${pi}`)),
  )
  enforceOrientationGroups(orientationGroups, chains)
  const res = safeResolution(setup.resolution)
  const countPoints = (): number => chains.reduce((sum, chain) => sum + chain.pts.length, 0)
  let maxPoints = countPoints()

  const captureCurves = (): Vec2[][] => chains.map((chain) => chain.pts.map((p): Vec2 => [p[0], p[1]]))
  const captureControls = (): number[][] => chains.map((chain) => chain.controlIndices)

  const displace = (dirs: Vec2[][], s: number): void => {
    chains.forEach((chain, ci) => {
      const { pts, model } = chain
      for (let k = 0; k < pts.length; k++) {
        if (!model.movable[k]) continue
        pts[k][0] += s * dirs[ci][k][0]
        pts[k][1] += s * dirs[ci][k][1]
      }
    })
  }

  // The kinematic projections: linked points, mesh density and control-point constraints.
  const project = (): void => {
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

  const frameOf = (i: number, ke: number): Frame => {
    const { length, bend } = potentialParts(chains, constants)
    return {
      i,
      ke,
      energy: length + bend + ke,
      lengthEnergy: length,
      bendEnergy: bend,
      curves: captureCurves(),
      controlIndices: captureControls(),
    }
  }

  const buffer = createFrameBuffer()
  const initialKe = totalKineticEnergy(chains)
  buffer.add(frameOf(0, initialKe))

  // Settle the pose onto the projections; the system starts at rest, so all its energy is potential.
  for (let k = 0; k < 3; k++) project()
  maxPoints = Math.max(maxPoints, countPoints())

  const { report, finalize } = makeProgressReporter(
    onProgress,
    maxIter,
    constants.gamma * constants.h,
  )
  report(0, initialKe, true)

  // Cap on the kinetic energy above the current potential energy; it follows an exponential cooling
  // schedule, so the drain does not depend on the last total energy. The budget itself never rises.
  let kineticAllowance = 0
  let energy = totalPotentialEnergy(chains, constants)
  let stepHint = 0
  let termination: 'ke' | 'maxIter' = 'maxIter'
  let settleStreak = 0
  let lastIter = 0
  let lastKe = initialKe
  let lastFrame: Frame = frameOf(0, initialKe)

  for (let i = 1; i <= maxIter; i++) {
    if (shouldCancel?.()) {
      throw new CancelledError()
    }

    // Direction: the force on every point, scaled so the largest error has unit weight.
    const forces = chains.map((chain) => computeAcceleration(chain.pts, constants, chain.model))
    chains.forEach((chain, ci) => verifyFinite(chain.pts, chain.vel, forces[ci]))
    let maxForce = 0
    for (const f of forces) for (const v of f) maxForce = Math.max(maxForce, length(v))
    const dirs: Vec2[][] = forces.map((f) => f.map((v): Vec2 => (maxForce > 0 ? [v[0] / maxForce, v[1] / maxForce] : [0, 0])))
    let dirSquares = 0
    for (const d of dirs) for (const v of d) dirSquares += v[0] * v[0] + v[1] * v[1]

    if (i === 1) kineticAllowance = (0.5 * (MAX_STEP_FRACTION * res) ** 2 * dirSquares) / (h * h)
    else kineticAllowance *= Math.exp(-2 * constants.gamma * h)
    energy = Math.min(energy, totalPotentialEnergy(chains, constants) + kineticAllowance)

    const potentialBefore = totalPotentialEnergy(chains, constants)
    const before = snapshot(chains)
    const pointsBefore = countPoints()
    const setVelocities = (s: number): void => {
      chains.forEach((chain, ci) =>
        chain.vel.forEach((v, k) => {
          v[0] = (s * dirs[ci][k][0]) / h
          v[1] = (s * dirs[ci][k][1]) / h
        }),
      )
    }
    const apply = (s: number): void => {
      restore(chains, before)
      setVelocities(s)
      displace(dirs, s)
      project()
    }
    // Excess energy of a step of size s: induced kinetic + resulting potential - budget.
    const excess = (s: number): number => {
      apply(s)
      return (0.5 * s * s * dirSquares) / (h * h) + totalPotentialEnergy(chains, constants) - energy
    }

    // The step is the scale at which the energy of the new state matches the budget again.
    const maxStep = MAX_STEP_FRACTION * res
    let s = 0
    if (maxForce > 0 && dirSquares > 0) {
      let trial = Math.min(maxStep, stepHint > 0 ? stepHint : maxStep / 16)
      let lo = 0
      let hi = -1
      if (excess(trial) > 0) {
        hi = trial
        for (let n = 0; n < MAX_BRACKET_STEPS; n++) {
          trial /= 2
          if (excess(trial) > 0) hi = trial
          else {
            lo = trial
            break
          }
        }
      } else {
        lo = trial
        for (let n = 0; n < MAX_BRACKET_STEPS && trial < maxStep; n++) {
          trial = Math.min(2 * trial, maxStep)
          if (excess(trial) > 0) {
            hi = trial
            break
          }
          lo = trial
        }
      }
      if (hi < 0) s = lo // the whole range is affordable: take the largest step
      else if (lo === 0 && hi > 0 && excess(hi / 2 ** MAX_BRACKET_STEPS) > 0) s = 0 // already at a minimum
      else {
        for (let n = 0; n < BISECTIONS; n++) {
          const mid = (lo + hi) / 2
          if (excess(mid) > 0) hi = mid
          else lo = mid
        }
        s = lo
      }
    }
    stepHint = s
    apply(s)
    if (s === 0) for (const chain of chains) for (const v of chain.vel) { v[0] = 0; v[1] = 0 }
    maxPoints = Math.max(maxPoints, countPoints())
    const countChanged =
      countPoints() !== pointsBefore || chains.some((chain, ci) => chain.pts.length !== before[ci].pts.length)

    let ke = totalKineticEnergy(chains)
    const pe = totalPotentialEnergy(chains, constants)
    if (countChanged) energy = pe + ke // a change of discretization re-baselines the budget
    // The kinetic energy is exactly what the budget leaves over; the projections must not change that.
    if (ke > 0 && energy > pe && !countChanged) {
      const factor = Math.sqrt((energy - pe) / ke)
      for (const chain of chains) for (const v of chain.vel) { v[0] *= factor; v[1] *= factor }
      ke *= factor * factor
    }

    // Rest only counts when forces could still turn potential energy into motion (e.g. at a turning
    // point of the motion). The effective force is the potential drop per distance moved, so forces
    // that the constraints block do not count.
    let effectiveForce = Infinity
    if (!countChanged) {
      let moved = 0
      chains.forEach((chain, ci) =>
        chain.pts.forEach((p, k) => {
          moved += (p[0] - before[ci].pts[k][0]) ** 2 + (p[1] - before[ci].pts[k][1]) ** 2
        }),
      )
      effectiveForce = moved > 0 ? Math.max(0, potentialBefore - pe) / Math.sqrt(moved) : 0
    }
    const atRest = ke < epsilon && effectiveForce < forceEpsilon
    if (atRest) settleStreak += 1
    else settleStreak = 0

    lastFrame = frameOf(i, ke)
    buffer.add(lastFrame)
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

  const frames = buffer.finish(lastFrame)

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
      buildChain(curve, setup.resolution, (pi) => linked.has(`${ci}:${pi}`)),
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
