import type { Constraint, Curve, FixPoint, PointId, Setup, Vec2 } from '../solver/types'
import { constraintProblems, locate, nextPointId } from '../solver/constraints'

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
  if (!curve || setup.curves.length <= 1) return setup
  const next = cloneSetup(setup)
  next.curves.splice(ci, 1)
  dropConstraintsOn(next, new Set(curve.fixPoints.map((fp) => fp.id)))
  return next
}

export function setResolution(setup: Setup, value: number): Setup {
  if (value === setup.resolution) return setup
  return { ...cloneSetup(setup), resolution: value }
}

export function setCurveTargetLength(setup: Setup, ci: number, value: number | null): Setup {
  const curve = setup.curves[ci]
  if (!curve) return setup
  if ((curve.targetLength ?? null) === value) return setup
  const next = cloneSetup(setup)
  next.curves[ci].targetLength = value
  return next
}

export function addFixPoint(setup: Setup, ci: number): Setup {
  const curve = setup.curves[ci]
  if (!curve) return setup
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

/**
 * Makes `target` follow another point for `kind`, with no offset. Prefers the
 * point before it on its curve, then the one after, then any other point that
 * does not form a loop. Unchanged when there is nothing to follow.
 */
export function followPoint(setup: Setup, kind: Constraint['kind'], target: PointId): Setup {
  const ref = locate(setup, target)
  if (!ref) return setup
  const { fixPoints } = setup.curves[ref.curve]
  const candidates = [
    fixPoints[ref.point - 1],
    fixPoints[ref.point + 1],
    ...setup.curves.flatMap((c) => c.fixPoints),
  ].filter((fp): fp is FixPoint => !!fp && fp.id !== target)
  for (const { id } of candidates) {
    const next = addConstraint(setup, { kind, source: id, target })
    if (next !== setup) return next
  }
  return setup
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
