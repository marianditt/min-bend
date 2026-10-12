import type { Curve, FixPoint, Setup, Vec2 } from '../solver/types'
import { freeSlotCount } from '../solver/curve'

/** Deep clone a setup so edits stay immutable. */
export function cloneSetup(setup: Setup): Setup {
  return structuredClone(setup)
}

export function createFixPoint(pos: Vec2): FixPoint {
  return { pos, orientation: null }
}

/** A new two-fix-point curve, offset horizontally so it does not overlap. */
export function createCurve(offsetX: number): Curve {
  return {
    n: 6,
    fixPoints: [createFixPoint([offsetX, 0]), createFixPoint([offsetX + 4, 0])],
    spans: [[]],
  }
}

export function addCurve(setup: Setup): Setup {
  const next = cloneSetup(setup)
  next.curves.push(createCurve(next.curves.length * 5))
  return next
}

export function removeCurve(setup: Setup, ci: number): Setup {
  if (setup.curves.length <= 1) return setup
  const next = cloneSetup(setup)
  next.curves.splice(ci, 1)
  return next
}

export function setCurveN(setup: Setup, ci: number, n: number): Setup {
  const curve = setup.curves[ci]
  if (!curve) return setup
  const value = Math.max(0, Math.floor(n))
  if (value === curve.n) return setup
  const next = cloneSetup(setup)
  const target = next.curves[ci]
  target.n = value
  target.spans = target.spans.map((span) => span.slice(0, value))
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
  const next = cloneSetup(setup)
  const target = next.curves[ci]
  target.fixPoints.push(createFixPoint([last.pos[0] + dx, last.pos[1] + dy]))
  target.spans.push([])
  return next
}

export function removeFixPoint(setup: Setup, ci: number, pi: number): Setup {
  const curve = setup.curves[ci]
  if (!curve || curve.fixPoints.length <= 2) return setup
  const next = cloneSetup(setup)
  const target = next.curves[ci]
  target.fixPoints.splice(pi, 1)
  target.spans.splice(Math.min(pi, target.spans.length - 1), 1)
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
  const curve = setup.curves[ci]
  const span = curve?.spans[si]
  if (!curve || !span) return setup
  if (span.length >= freeSlotCount(curve, si)) return setup
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
