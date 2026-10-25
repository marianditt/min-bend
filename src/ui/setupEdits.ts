import type { Constraint, Curve, FixPoint, PointId, Setup, Vec2 } from '../solver/types'
import { DEFAULT_FLATNESS } from '../solver/types'
import { constraintFor, constraintProblems, locate, nextPointId } from '../solver/constraints'

/** Deep clone a setup so edits stay immutable. */
export function cloneSetup(setup: Setup): Setup {
  return structuredClone(setup)
}

export function createFixPoint(id: PointId, pos: Vec2): FixPoint {
  return { id, pos, orientation: null }
}

/** Vertical distance between the default positions of consecutive curves. */
const CURVE_SPACING = 2

/** A new curve running left to right, below the existing ones so it does not overlap. */
export function createCurve(setup: Setup): Curve {
  const y = -setup.curves.length * CURVE_SPACING
  return createCurveThrough(setup, [
    [0, y],
    [4, y],
  ])
}

/** A curve through the given positions (at least two), with fresh point ids. */
export function createCurveThrough(setup: Setup, positions: Vec2[]): Curve {
  const first = Number(nextPointId(setup).slice(1))
  return {
    fixPoints: positions.map((p, i) => createFixPoint(`p${first + i}`, [p[0], p[1]])),
    spans: positions.slice(1).map(() => []),
  }
}

export function addCurve(setup: Setup): Setup {
  const next = cloneSetup(setup)
  next.curves.push(createCurve(setup))
  return next
}

/** Adds a curve through `positions` (at least two); a stroke sketched on the canvas becomes one. */
export function addCurveThrough(setup: Setup, positions: Vec2[]): Setup {
  if (positions.length < 2) return setup
  const next = cloneSetup(setup)
  next.curves.push(createCurveThrough(setup, positions))
  return next
}

export function removeCurve(setup: Setup, ci: number): Setup {
  const curve = setup.curves[ci]
  if (!curve) return setup
  const next = cloneSetup(setup)
  next.curves.splice(ci, 1)
  dropConstraintsOn(next, new Set(curve.fixPoints.map((fp) => fp.id)))
  // A setup always has a curve: deleting the last one leaves a fresh default curve.
  if (next.curves.length === 0) next.curves.push(createCurve(next))
  return next
}

export function setResolution(setup: Setup, value: number): Setup {
  if (value === setup.resolution) return setup
  return { ...cloneSetup(setup), resolution: value }
}

export function setCurveFlatness(setup: Setup, ci: number, value: number): Setup {
  const curve = setup.curves[ci]
  if (!curve || (curve.flatness ?? DEFAULT_FLATNESS) === value) return setup
  const next = cloneSetup(setup)
  next.curves[ci].flatness = value
  return next
}

export function setCurveTargetLength(setup: Setup, ci: number, value: number | null): Setup {
  const curve = setup.curves[ci]
  if (!curve) return setup
  if ((curve.targetLength ?? null) === value) return setup
  const next = cloneSetup(setup)
  next.curves[ci].targetLength = value
  return next
}

/**
 * A closed curve ends where it starts: its last control point follows the first
 * one's position and orientation, so the loop is smooth at the join.
 */
export function isCurveClosed(setup: Setup, ci: number): boolean {
  const pts = setup.curves[ci]?.fixPoints
  if (!pts || pts.length < 2) return false
  const first = pts[0].id
  const last = pts[pts.length - 1].id
  return (['position', 'orientation'] as const).every((kind) => constraintFor(setup, kind, last)?.source === first)
}

export function setCurveClosed(setup: Setup, ci: number, closed: boolean): Setup {
  const pts = setup.curves[ci]?.fixPoints
  if (!pts || pts.length < 2 || isCurveClosed(setup, ci) === closed) return setup
  const first = pts[0].id
  const last = pts[pts.length - 1].id
  if (!closed) return removeConstraintOn(removeConstraintOn(setup, 'position', last), 'orientation', last)
  const withPos = addConstraint(setup, { kind: 'position', source: first, target: last })
  return withPos === setup ? setup : addConstraint(withPos, { kind: 'orientation', source: first, target: last })
}

export function addFixPoint(setup: Setup, ci: number): Setup {
  const curve = setup.curves[ci]
  if (!curve) return setup
  if (isCurveClosed(setup, ci)) {
    // Keep the closing point last: insert before it, halfway along the final span.
    const [a, b] = curve.fixPoints.slice(-2)
    const next = cloneSetup(setup)
    const target = next.curves[ci]
    const at = target.fixPoints.length - 1
    target.fixPoints.splice(at, 0, createFixPoint(nextPointId(setup), [(a.pos[0] + b.pos[0]) / 2, (a.pos[1] + b.pos[1]) / 2]))
    target.spans.splice(at, 0, [])
    return next
  }
  const count = curve.fixPoints.length
  const last = curve.fixPoints[count - 1]
  const prev = curve.fixPoints[count - 2] ?? last
  let dx = last.pos[0] - prev.pos[0]
  let dy = last.pos[1] - prev.pos[1]
  if (Math.hypot(dx, dy) < 1e-6) {
    dx = 4
    dy = 0
  }
  return addFixPointAt(setup, ci, [last.pos[0] + dx, last.pos[1] + dy])
}

/** Appends a control point at `pos` to the end of curve `ci`. */
export function addFixPointAt(setup: Setup, ci: number, pos: Vec2): Setup {
  if (!setup.curves[ci]) return setup
  const next = cloneSetup(setup)
  const target = next.curves[ci]
  target.fixPoints.push(createFixPoint(nextPointId(setup), [pos[0], pos[1]]))
  target.spans.push([])
  return next
}

export function removeFixPoint(setup: Setup, ci: number, pi: number): Setup {
  const curve = setup.curves[ci]
  if (!curve || curve.fixPoints.length <= 2 || !curve.fixPoints[pi]) return setup
  const next = cloneSetup(setup)
  const target = next.curves[ci]
  const [removed] = target.fixPoints.splice(pi, 1)
  target.spans.splice(Math.min(pi, target.spans.length - 1), 1)
  dropConstraintsOn(next, new Set([removed.id]))
  return next
}

/** Moves a control point to an absolute position. */
export function moveFixTo(setup: Setup, ci: number, pi: number, pos: Vec2): Setup {
  const fp = setup.curves[ci]?.fixPoints[pi]
  if (!fp) return setup
  const next = cloneSetup(setup)
  next.curves[ci].fixPoints[pi].pos = [pos[0], pos[1]]
  return next
}

export function moveFix(setup: Setup, ci: number, pi: number, axis: 0 | 1, value: number): Setup {
  const fp = setup.curves[ci]?.fixPoints[pi]
  if (!fp) return setup
  const next = cloneSetup(setup)
  next.curves[ci].fixPoints[pi].pos[axis] = value
  return next
}

export function setFixOrientation(
  setup: Setup,
  ci: number,
  pi: number,
  orientation: Vec2 | null,
): Setup {
  const fp = setup.curves[ci]?.fixPoints[pi]
  if (!fp) return setup
  const next = cloneSetup(setup)
  next.curves[ci].fixPoints[pi].orientation = orientation ? [orientation[0], orientation[1]] : null
  return next
}

export function setFixPosFree(setup: Setup, ci: number, pi: number, free: boolean): Setup {
  const fp = setup.curves[ci]?.fixPoints[pi]
  if (!fp || (fp.posFree === true) === free) return setup
  const next = cloneSetup(setup)
  const target = next.curves[ci].fixPoints[pi]
  if (free) target.posFree = true
  else delete target.posFree
  return next
}

export function setFixOrientationComponent(
  setup: Setup,
  ci: number,
  pi: number,
  axis: 0 | 1,
  value: number,
): Setup {
  const fp = setup.curves[ci]?.fixPoints[pi]
  if (!fp || !fp.orientation) return setup
  const next = cloneSetup(setup)
  const orient = next.curves[ci].fixPoints[pi].orientation
  if (!orient) return setup
  orient[axis] = value
  return next
}

export function addFreePoint(setup: Setup, ci: number, si: number, p: Vec2): Setup {
  const span = setup.curves[ci]?.spans[si]
  if (!span) return setup
  const next = cloneSetup(setup)
  next.curves[ci].spans[si].push([p[0], p[1]])
  return next
}

export function removeLastFreePoint(setup: Setup, ci: number, si: number): Setup {
  const span = setup.curves[ci]?.spans[si]
  if (!span || span.length === 0) return setup
  const next = cloneSetup(setup)
  next.curves[ci].spans[si].pop()
  return next
}

export function clearSpan(setup: Setup, ci: number, si: number): Setup {
  const span = setup.curves[ci]?.spans[si]
  if (!span || span.length === 0) return setup
  const next = cloneSetup(setup)
  next.curves[ci].spans[si] = []
  return next
}

export function toggleCurveHidden(setup: Setup, ci: number): Setup {
  const curve = setup.curves[ci]
  if (!curve) return setup
  const next = cloneSetup(setup)
  next.curves[ci].hidden = !curve.hidden
  return next
}

/** Removes every constraint that refers to one of the (deleted) point ids. */
function dropConstraintsOn(setup: Setup, ids: Set<PointId>): void {
  if (!setup.constraints) return
  const kept = setup.constraints.filter((c) => !ids.has(c.source) && !ids.has(c.target))
  if (kept.length > 0) setup.constraints = kept
  else delete setup.constraints
}

/**
 * Constrains `target` to follow `source` for the given property. Replaces an
 * existing constraint of the same kind on the target; ignored when invalid
 * (self reference or loop).
 */
export function addConstraint(setup: Setup, constraint: Constraint): Setup {
  const next = cloneSetup(setup)
  const rest = (next.constraints ?? []).filter(
    (c) => !(c.kind === constraint.kind && c.target === constraint.target),
  )
  next.constraints = [...rest, constraint]
  return constraintProblems(next).length > 0 ? setup : next
}

export function removeConstraint(setup: Setup, index: number): Setup {
  if (!setup.constraints?.[index]) return setup
  const next = cloneSetup(setup)
  next.constraints?.splice(index, 1)
  if (next.constraints?.length === 0) delete next.constraints
  return next
}

/** Stops `target` from following another point for the given property. */
export function removeConstraintOn(setup: Setup, kind: Constraint['kind'], target: PointId): Setup {
  const index = (setup.constraints ?? []).findIndex((c) => c.kind === kind && c.target === target)
  return index < 0 ? setup : removeConstraint(setup, index)
}

/** Constraints (of either kind) whose target sits on curve `ci`. */
function followsOnCurve(setup: Setup, ci: number): Constraint[] {
  return (setup.constraints ?? []).filter((c) => locate(setup, c.target)?.curve === ci)
}

/**
 * Makes `target` follow another point for `kind`, with no offset. A point has
 * only one source, so it keeps the source its other property already follows.
 * Otherwise `preferred` (the source picked in the UI) is used alone; failing
 * that the choice mirrors the curve's other points: if a neighbouring
 * point follows a point of curve X, `target` follows the point of X at the same
 * distance (else any point of X). Failing that, the first other point in the
 * setup. Unchanged when there is nothing valid to follow.
 */
export function followPoint(setup: Setup, kind: Constraint['kind'], target: PointId, preferred?: PointId | null): Setup {
  const ref = locate(setup, target)
  if (!ref) return setup
  const candidates: PointId[] = []
  const other = (setup.constraints ?? []).find((c) => c.target === target && c.kind !== kind)
  if (other) candidates.push(other.source)
  else if (preferred) candidates.push(preferred)
  else {
    const mine = followsOnCurve(setup, ref.curve)
      .map((c) => ({ c, from: locate(setup, c.target)!, to: locate(setup, c.source)! }))
      .sort((a, b) => Math.abs(a.from.point - ref.point) - Math.abs(b.from.point - ref.point))
    for (const { from, to } of mine) {
      const points = setup.curves[to.curve].fixPoints
      const same = points[to.point + ref.point - from.point]
      if (same) candidates.push(same.id)
      candidates.push(...points.map((fp) => fp.id))
    }
    candidates.push(...setup.curves.flatMap((c) => c.fixPoints.map((fp) => fp.id)))
  }
  for (const source of candidates) {
    if (source === target) continue
    const next = addConstraint(setup, { kind, source, target })
    if (next !== setup) return next
  }
  return setup
}

/**
 * Re-points the existing constraints of `target` to `source` (null removes them).
 * A target without constraints is left alone; the caller remembers the chosen
 * source until a property starts following. Unchanged when it would form a loop.
 */
export function setFollowSource(setup: Setup, target: PointId, source: PointId | null): Setup {
  const own = (setup.constraints ?? []).filter((c) => c.target === target)
  if (source === null) return own.reduce((s, c) => removeConstraintOn(s, c.kind, target), setup)
  let next = setup
  for (const c of own) {
    const updated = addConstraint(next, { ...c, source })
    if (updated === next) return setup
    next = updated
  }
  return next
}

/** Changes the offset of an existing constraint: degrees for orientation, [dx, dy] for position. */
export function setConstraintDelta(setup: Setup, kind: Constraint['kind'], target: PointId, delta: number | Vec2): Setup {
  const index = (setup.constraints ?? []).findIndex((c) => c.kind === kind && c.target === target)
  if (index < 0) return setup
  const next = cloneSetup(setup)
  const c = next.constraints![index]
  if (c.kind === 'position' && Array.isArray(delta)) c.delta = [delta[0], delta[1]]
  else if (c.kind === 'orientation' && typeof delta === 'number') c.delta = delta
  else return setup
  return next
}

/** Sets the direction mapping of an orientation constraint: angle = (mirror ? -source : source) + delta. */
export function setOrientationMapping(setup: Setup, target: PointId, mapping: { mirror: boolean; delta: number }): Setup {
  const index = (setup.constraints ?? []).findIndex((c) => c.kind === 'orientation' && c.target === target)
  if (index < 0) return setup
  const next = cloneSetup(setup)
  const c = next.constraints![index]
  if (c.kind !== 'orientation') return setup
  c.delta = mapping.delta
  if (mapping.mirror) c.mirror = true
  else delete c.mirror
  return next
}
