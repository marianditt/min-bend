import type { Curve, Frame, FrameMeta, FrameSet, PhysicsConstants, Setup, Vec2 } from './types'
import { DEFAULT_CONSTANTS, DEFAULT_FLATNESS, SETTLE_STEPS } from './types'
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
  controlMass: number
  /** Replaced (never mutated) whenever the point count changes. */
  controlIndices: number[]
}

/** Per-step displacement cap, as a fraction of the resolution; keeps a stiff transient from exploding. */
const MAX_STEP_FRACTION = 0.25

/** Force per radian of turning angle at a point of a curve whose flatness is 1. */
const BEND_GAIN = 1
/** Length-force stiffness, per resolution unit, of a free curve whose flatness is 0. */
const LENGTH_GAIN = 1

/** Physics weights of one curve, derived from its flatness, length constraint and the resolution. */
interface Weights {
  bendStiffness: number
  lengthStiffness: number
}

/**
 * The flatness slider weights the two forces: at 0 no point feels a bend force,
 * at 1 a free-length curve feels no length force. A target length is a
 * constraint and keeps its full stiffness.
 */
function curveWeights(curve: Curve, res: number, hasTarget: boolean): Weights {
  const raw = curve.flatness
  const flat = typeof raw === 'number' && Number.isFinite(raw) ? Math.min(1, Math.max(0, raw)) : DEFAULT_FLATNESS
  return {
    bendStiffness: BEND_GAIN * flat,
    lengthStiffness: ((hasTarget ? LENGTH_STIFFNESS : LENGTH_GAIN * (1 - flat))) / res,
  }
}

function buildModel(
  total: number,
  controls: ControlSpec[],
  controlIndices: number[],
  targetLength: number | null,
  weights: Weights,
  controlMass: number,
): ChainModel {
  const movable: boolean[] = new Array(total).fill(true)
  const mass: number[] = new Array(total).fill(1)
  const constraints: PointConstraint[] = []
  controls.forEach((c, j) => {
    const index = controlIndices[j]
    mass[index] = controlMass
    if (!c.movable) movable[index] = false
    if (c.dir) constraints.push({ index, dir: c.dir, collinear: false })
    else if (c.collinear) constraints.push({ index, dir: null, collinear: true })
  })
  return { movable, mass, targetLength, constraints, ...weights }
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
  controlMass: number = DEFAULT_CONSTANTS.controlMass,
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

  const weights = curveWeights(curve, res, targetLength !== null)
  const model = buildModel(pts.length, controls, plan.controlIndices, targetLength, weights, controlMass)
  const vel: Vec2[] = pts.map(() => [0, 0])
  enforceConstraints(pts, vel, model.constraints)
  return { pts, vel, model, controls, targetLength, weights, controlMass, controlIndices: plan.controlIndices }
}

function totalKineticEnergy(chains: ChainState[]): number {
  let ke = 0
  for (const chain of chains) ke += computeKineticEnergy(chain.vel, chain.model.mass)
  return ke
}

function potentialParts(chains: ChainState[]): EnergyParts {
  const parts: EnergyParts = { length: 0, bend: 0 }
  for (const chain of chains) {
    const p = computeEnergyParts(chain.pts, chain.model)
    parts.length += p.length
    parts.bend += p.bend
  }
  return parts
}

/**
 * Report progress with ~50ms throttling. The final sample (via `finalize`)
 * always reports 1.0 together with the true last iteration and energy, so the
 * UI never flashes the configured maxSteps as if the run had used it all.
 */
function makeProgressReporter(
  onProgress: SolveOptions['onProgress'],
  maxSteps: number,
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
    shown = Math.max(shown, tracker.progress(iteration, maxSteps))
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
  const { friction, timeStep, restThreshold, maxSteps } = constants

  const linked = linkedKeys(orientationGroups)
  const chains = setup.curves.map((curve, ci) =>
    buildChain(curve, setup.resolution, (pi) => linked.has(`${ci}:${pi}`), constants.controlMass),
  )
  enforceOrientationGroups(orientationGroups, chains)
  const res = safeResolution(setup.resolution)
  const countPoints = (): number => chains.reduce((sum, chain) => sum + chain.pts.length, 0)
  let maxPoints = countPoints()

  const captureCurves = (): Vec2[][] => chains.map((chain) => chain.pts.map((p): Vec2 => [p[0], p[1]]))
  const captureControls = (): number[][] => chains.map((chain) => chain.controlIndices)

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
        chain.model = buildModel(chain.pts.length, chain.controls, indices, chain.targetLength, chain.weights, chain.controlMass)
      }
      equalizeSegments(chain.pts, chain.vel, chain.controlIndices)
      enforceConstraints(chain.pts, chain.vel, chain.model.constraints)
    }
    enforceOrientationGroups(orientationGroups, chains)
    for (const chain of chains) verifyFinite(chain.pts, chain.vel, chain.vel)
  }

  const frameOf = (i: number, ke: number): Frame => {
    const { length, bend } = potentialParts(chains)
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
    maxSteps,
    friction * timeStep,
  )
  report(0, initialKe, true)

  // Stability limit of the explicit integrator, re-evaluated every step. The stiffest bend mode
  // oscillates with omega² ~ 8·stiffness/l (l = shortest segment) and the collective length mode with
  // omega² ~ 4·k (both divided by the lightest mass); the step must stay well below 1/omega.
  const stableStep = (): number => {
    let limit = Infinity
    for (const { pts, model } of chains) {
      let shortest = Infinity
      for (let k = 0; k + 1 < pts.length; k++) {
        shortest = Math.min(shortest, Math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]))
      }
      shortest = Math.max(shortest, 0.05 * res)
      const bend = (8 * (model.bendStiffness ?? 1)) / shortest
      const tension = 4 * (model.lengthStiffness ?? 0)
      const omega = Math.sqrt((bend + tension) / Math.min(1, constants.controlMass) + friction * friction)
      if (omega > 0) limit = Math.min(limit, 0.5 / omega)
    }
    return limit
  }
  let termination: 'rest' | 'maxSteps' = 'maxSteps'
  let settleStreak = 0
  let lastIter = 0
  let lastKe = initialKe
  let lastFrame: Frame = frameOf(0, initialKe)

  for (let i = 1; i <= maxSteps; i++) {
    if (shouldCancel?.()) {
      throw new CancelledError()
    }

    // Forces (bend + length error) divided by the masses give the accelerations.
    const accels = chains.map((chain) => computeAcceleration(chain.pts, chain.model))
    chains.forEach((chain, ci) => verifyFinite(chain.pts, chain.vel, accels[ci]))

    // Semi-implicit Euler with linear friction: unconditionally stable in the damping term.
    const step = Math.min(timeStep, stableStep())
    const pointsBefore = countPoints()
    const before = chains.map((chain) => chain.pts.map((p): Vec2 => [p[0], p[1]]))
    const maxMove = MAX_STEP_FRACTION * res
    chains.forEach((chain, ci) => {
      const { pts, vel, model } = chain
      for (let k = 0; k < pts.length; k++) {
        if (!model.movable[k]) {
          vel[k][0] = 0
          vel[k][1] = 0
          continue
        }
        let vx = (vel[k][0] + step * accels[ci][k][0]) / (1 + step * friction)
        let vy = (vel[k][1] + step * accels[ci][k][1]) / (1 + step * friction)
        const move = step * Math.hypot(vx, vy)
        if (move > maxMove) {
          vx *= maxMove / move
          vy *= maxMove / move
        }
        vel[k][0] = vx
        vel[k][1] = vy
        pts[k][0] += step * vx
        pts[k][1] += step * vy
      }
    })
    project()
    maxPoints = Math.max(maxPoints, countPoints())
    const countChanged =
      countPoints() !== pointsBefore || chains.some((chain, ci) => chain.pts.length !== before[ci].length)

    const ke = totalKineticEnergy(chains)
    // Rest: no motion left. A change of the point count is never rest.
    const atRest = !countChanged && ke < restThreshold
    if (atRest) settleStreak += 1
    else settleStreak = 0

    lastFrame = frameOf(i, ke)
    buffer.add(lastFrame)
    lastIter = i
    lastKe = ke

    report(i, ke)

    if (settleStreak >= SETTLE_STEPS) {
      termination = 'rest'
      break
    }
    if (i >= maxSteps) {
      termination = 'maxSteps'
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
