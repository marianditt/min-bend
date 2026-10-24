import type { Constraint, PointRef, Setup, Vec2 } from './types'

export const sameRef = (a: PointRef, b: PointRef): boolean => a.curve === b.curve && a.point === b.point

export function refExists(setup: Setup, ref: PointRef): boolean {
  return Number.isInteger(ref?.curve) && Number.isInteger(ref?.point) && !!setup.curves[ref.curve]?.fixPoints[ref.point]
}

/** The constraint of `kind` that drives `target`, if any. */
export function constraintFor(setup: Setup, kind: Constraint['kind'], target: PointRef): Constraint | undefined {
  return setup.constraints?.find((c) => c.kind === kind && sameRef(c.target, target))
}

/** Follows target -> source links to the point that is not itself driven. Null on a cycle. */
export function rootOf(setup: Setup, kind: Constraint['kind'], ref: PointRef): PointRef | null {
  let cur = ref
  for (let n = 0; n <= (setup.constraints?.length ?? 0); n++) {
    const c = constraintFor(setup, kind, cur)
    if (!c) return cur
    cur = c.source
  }
  return null
}

/** Human readable name of a point, e.g. "Curve 2 · point 3". */
export function pointLabel(ref: PointRef): string {
  return `Curve ${ref.curve + 1} · point ${ref.point + 1}`
}

/** Returns problems (for validation) with the constraint list itself. */
export function constraintProblems(setup: Setup): { index: number; message: string }[] {
  const out: { index: number; message: string }[] = []
  const list = setup.constraints ?? []
  list.forEach((c, i) => {
    if (!refExists(setup, c.source) || !refExists(setup, c.target)) {
      out.push({ index: i, message: 'A constrained point no longer exists.' })
    } else if (sameRef(c.source, c.target)) {
      out.push({ index: i, message: 'A point cannot be constrained to itself.' })
    } else if (list.findIndex((o) => o.kind === c.kind && sameRef(o.target, c.target)) !== i) {
      out.push({
        index: i,
        message: `${pointLabel(c.target)} already has a ${c.kind} constraint.`,
      })
    } else if (rootOf(setup, c.kind, c.target) === null) {
      out.push({ index: i, message: `The ${c.kind} constraints form a loop.` })
    }
  })
  return out
}

/**
 * Applies constraints to a copy of the setup: driven points take over the
 * values of their source. Also returns groups of free-position points that
 * the solver must keep together (each group lists [curve, point] pairs).
 */
export function resolveSetup(setup: Setup): { setup: Setup; groups: PointRef[][] } {
  const list = setup.constraints ?? []
  if (list.length === 0 || constraintProblems(setup).length > 0) return { setup, groups: [] }
  const next = structuredClone(setup)
  const fp = (r: PointRef) => next.curves[r.curve].fixPoints[r.point]

  // Process sources before targets so chains resolve in a single pass.
  const depth = (c: Constraint): number => {
    let d = 0
    let cur: PointRef = c.target
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
    const src = fp(c.source)
    const dst = fp(c.target)
    if (c.kind === 'position') {
      dst.pos = [src.pos[0], src.pos[1]] as Vec2
      if (src.posFree) dst.posFree = true
      else delete dst.posFree
    } else {
      dst.orientation = src.orientation ? [src.orientation[0], src.orientation[1]] : null
    }
  }

  const byRoot = new Map<string, PointRef[]>()
  for (const c of list) {
    if (c.kind !== 'position') continue
    const root = rootOf(setup, 'position', c.target)
    if (!root || !fp(root).posFree) continue
    const key = `${root.curve}:${root.point}`
    const group = byRoot.get(key) ?? [root]
    group.push(c.target)
    byRoot.set(key, group)
  }
  return { setup: next, groups: [...byRoot.values()] }
}
