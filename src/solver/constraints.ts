import type { Constraint, PointId, PointRef, Setup, Vec2 } from './types'

/** Where the point with this id currently sits in the setup, or null when it no longer exists. */
export function locate(setup: Setup, id: PointId): PointRef | null {
  for (let curve = 0; curve < setup.curves.length; curve++) {
    const point = setup.curves[curve].fixPoints.findIndex((fp) => fp.id === id)
    if (point >= 0) return { curve, point }
  }
  return null
}

/** The next unused point id ("p1", "p2", ...). */
export function nextPointId(setup: Setup): PointId {
  let max = 0
  for (const curve of setup.curves) {
    for (const fp of curve.fixPoints) {
      const m = /^p(\d+)$/.exec(fp.id)
      if (m) max = Math.max(max, Number(m[1]))
    }
  }
  return `p${max + 1}`
}

/** The constraint of `kind` that drives `target`, if any. */
export function constraintFor(setup: Setup, kind: Constraint['kind'], target: PointId): Constraint | undefined {
  return setup.constraints?.find((c) => c.kind === kind && c.target === target)
}

/** Follows target -> source links to the point that is not itself driven. Null on a cycle. */
export function rootOf(setup: Setup, kind: Constraint['kind'], id: PointId): PointId | null {
  let cur = id
  for (let n = 0; n <= (setup.constraints?.length ?? 0); n++) {
    const c = constraintFor(setup, kind, cur)
    if (!c) return cur
    cur = c.source
  }
  return null
}

/** Human readable name of a point, e.g. "Curve 2 · Point 3". */
export function pointLabel(setup: Setup, id: PointId): string {
  const ref = locate(setup, id)
  return ref ? `Curve ${ref.curve + 1} · Point ${ref.point + 1}` : 'a deleted point'
}

/** Returns problems (for validation) with the constraint list itself. */
export function constraintProblems(setup: Setup): { index: number; message: string }[] {
  const out: { index: number; message: string }[] = []
  const list = setup.constraints ?? []
  list.forEach((c, i) => {
    const delta = c.delta
    const deltaOk =
      delta === undefined ||
      (c.kind === 'orientation'
        ? Number.isFinite(delta)
        : Array.isArray(delta) && delta.length === 2 && Number.isFinite(delta[0]) && Number.isFinite(delta[1]))
    if (!locate(setup, c.source) || !locate(setup, c.target)) {
      out.push({ index: i, message: 'A constrained point no longer exists.' })
    } else if (c.source === c.target) {
      out.push({ index: i, message: 'A point cannot be constrained to itself.' })
    } else if (locate(setup, c.source)!.curve === locate(setup, c.target)!.curve) {
      out.push({ index: i, message: `${pointLabel(setup, c.target)} can only follow a point of another curve.` })
    } else if (list.some((o) => o.target === c.target && o.source !== c.source)) {
      out.push({ index: i, message: `${pointLabel(setup, c.target)} can only follow one other point.` })
    } else if (list.findIndex((o) => o.kind === c.kind && o.target === c.target) !== i) {
      out.push({
        index: i,
        message: `${pointLabel(setup, c.target)} already has a ${c.kind} constraint.`,
      })
    } else if (rootOf(setup, c.kind, c.target) === null) {
      out.push({ index: i, message: `The ${c.kind} constraints form a loop.` })
    } else if (!deltaOk) {
      out.push({ index: i, message: 'The offset must be finite numbers.' })
    }
  })
  return out
}

/** Points that must keep a fixed position offset to each other while solving. */
export type PositionGroup = { ref: PointRef; offset: Vec2 }[]
/** Points whose tangents must keep a fixed angular offset (radians) to each other while solving. */
export type OrientationGroup = { ref: PointRef; angle: number }[]

const rotate = (v: Vec2, deg: number): Vec2 => {
  const r = (deg * Math.PI) / 180
  const c = Math.cos(r)
  const s = Math.sin(r)
  return [v[0] * c - v[1] * s, v[0] * s + v[1] * c]
}

/**
 * Applies constraints to a copy of the setup: driven points take over the
 * values of their source (plus offset). Also returns the groups the solver
 * must keep together: free-position points, and points whose source has a
 * free orientation (the shared tangent is then decided by all their curves).
 */
export function resolveSetup(setup: Setup): {
  setup: Setup
  positionGroups: PositionGroup[]
  orientationGroups: OrientationGroup[]
} {
  const list = setup.constraints ?? []
  if (list.length === 0 || constraintProblems(setup).length > 0) {
    return { setup, positionGroups: [], orientationGroups: [] }
  }
  const next = structuredClone(setup)
  const fpById = (id: PointId) => {
    const r = locate(next, id)!
    return next.curves[r.curve].fixPoints[r.point]
  }

  // Process sources before targets so chains resolve in a single pass.
  const depth = (c: Constraint): number => {
    let d = 0
    let cur: PointId = c.target
    while (d <= list.length) {
      const up = constraintFor(setup, c.kind, cur)
      if (!up) break
      cur = up.source
      d++
    }
    return d
  }
  const ordered = [...list].sort((a, b) => depth(a) - depth(b))
  for (const c of ordered) {
    const src = fpById(c.source)
    const dst = fpById(c.target)
    if (c.kind === 'position') {
      const [dx, dy] = c.delta ?? [0, 0]
      dst.pos = [src.pos[0] + dx, src.pos[1] + dy]
      if (src.posFree) dst.posFree = true
      else delete dst.posFree
    } else {
      dst.orientation = src.orientation ? rotate(src.orientation, c.delta ?? 0) : null
    }
  }

  const positionGroups = new Map<PointId, PositionGroup>()
  const orientationGroups = new Map<PointId, OrientationGroup>()
  for (const c of list) {
    const root = rootOf(setup, c.kind, c.target)!
    const rootRef = locate(next, root)!
    const targetRef = locate(next, c.target)!
    // Total offset from the root down to this target.
    let cur: Constraint | undefined = c
    let dx = 0
    let dy = 0
    let deg = 0
    while (cur) {
      if (cur.kind === 'position') {
        dx += cur.delta?.[0] ?? 0
        dy += cur.delta?.[1] ?? 0
      } else deg += cur.delta ?? 0
      cur = constraintFor(setup, c.kind, cur.source)
    }
    if (c.kind === 'position') {
      if (!fpById(root).posFree) continue
      const group = positionGroups.get(root) ?? [{ ref: rootRef, offset: [0, 0] as Vec2 }]
      group.push({ ref: targetRef, offset: [dx, dy] })
      positionGroups.set(root, group)
    } else {
      if (fpById(root).orientation) continue
      const group = orientationGroups.get(root) ?? [{ ref: rootRef, angle: 0 }]
      group.push({ ref: targetRef, angle: (deg * Math.PI) / 180 })
      orientationGroups.set(root, group)
    }
  }
  return { setup: next, positionGroups: [...positionGroups.values()], orientationGroups: [...orientationGroups.values()] }
}
