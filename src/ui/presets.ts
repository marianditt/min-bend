import type { Setup, Vec2 } from '../solver/types'
import { addCurveThrough, setCurveClosed } from './setupEdits'

export interface NgonParams {
  n: number
  origin: Vec2
  radius: number
}

export const DEFAULT_NGON: NgonParams = { n: 6, origin: [0, 0], radius: 2 }

/** Vertices of a regular n-gon, counter-clockwise, the first one at angle 0. */
export function ngonVertices({ n, origin, radius }: NgonParams): Vec2[] {
  return Array.from({ length: n }, (_, i) => {
    const a = (2 * Math.PI * i) / n
    return [origin[0] + radius * Math.cos(a), origin[1] + radius * Math.sin(a)]
  })
}

/** Why the parameters cannot form an n-gon, or null when they are fine. */
export function ngonProblem({ n, origin, radius }: NgonParams): string | null {
  if (!Number.isInteger(n) || n < 3) return 'n must be an integer of at least 3'
  if (!(radius > 0) || !Number.isFinite(radius)) return 'radius must be positive'
  if (!origin.every(Number.isFinite)) return 'origin must be finite'
  return null
}

/** Adds a closed n-gon as a curve: n + 1 control points, the last one closing the loop on the first. */
export function addNgon(setup: Setup, params: NgonParams): Setup {
  if (ngonProblem(params)) return setup
  const verts = ngonVertices(params)
  const added = addCurveThrough(setup, [...verts, verts[0]])
  return setCurveClosed(added, added.curves.length - 1, true)
}
