import type { Vec2 } from './types'
import { MAX_SEGMENTS_PER_SPAN, MIN_SEGMENTS } from './curve'

/**
 * A span grows a segment once its length exceeds `segments * resolution` by
 * this fraction of a resolution unit, and loses one once it falls that far
 * below `(segments - 1) * resolution`. The margin prevents flip-flopping.
 */
export const REMESH_MARGIN = 0.5

/** A segment shorter than this fraction of the resolution has collapsed and is merged away. */
export const COLLAPSE_FRACTION = 0.05

/**
 * Adds or removes interior points so that every span keeps roughly one point
 * per resolution unit of length. All segments of a span shrink and grow freely;
 * when their summed change amounts to a full resolution unit the span gains or
 * loses one point (a new point splits the longest segment, a removed point
 * merges the shortest). Mutates `pts` and `vel` in place.
 *
 * @returns the updated control point indices (the same array when nothing changed).
 */
export function remesh(pts: Vec2[], vel: Vec2[], controlIndices: number[], resolution: number): number[] {
  let indices = controlIndices
  for (let s = controlIndices.length - 2; s >= 0; s--) {
    const a = indices[s]
    const b = indices[s + 1]
    const n = b - a

    let total = 0
    let longest = a
    let shortest = a
    let longestLen = -1
    let shortestLen = Infinity
    for (let k = a; k < b; k++) {
      const len = Math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1])
      total += len
      if (len > longestLen) { longestLen = len; longest = k }
      if (len < shortestLen) { shortestLen = len; shortest = k }
    }

    const grow = n < MAX_SEGMENTS_PER_SPAN && total > (n + REMESH_MARGIN) * resolution
    const shrink =
      n > MIN_SEGMENTS &&
      (total < (n - 1 - REMESH_MARGIN) * resolution || shortestLen < COLLAPSE_FRACTION * resolution)

    if (grow) {
      const p = pts[longest]
      const q = pts[longest + 1]
      pts.splice(longest + 1, 0, [(p[0] + q[0]) / 2, (p[1] + q[1]) / 2])
      vel.splice(longest + 1, 0, [(vel[longest][0] + vel[longest + 1][0]) / 2, (vel[longest][1] + vel[longest + 1][1]) / 2])
      indices = indices.map((idx, j) => (j > s ? idx + 1 : idx))
    } else if (shrink) {
      // Drop an interior endpoint of the shortest segment, never a control point.
      const drop = shortest + 1 < b ? shortest + 1 : shortest
      pts.splice(drop, 1)
      vel.splice(drop, 1)
      indices = indices.map((idx, j) => (j > s ? idx - 1 : idx))
    }
  }
  return indices
}

/**
 * Keeps the segments of every span the same length: each interior point slides
 * along its local tangent to its equal arc-length slot, and the sliding
 * component of its velocity is dropped. This is a kinematic projection, not a
 * force, so it adds no stiffness parameter; the span as a whole shrinks and
 * grows while its segments share the change evenly.
 */
export function equalizeSegments(pts: Vec2[], vel: Vec2[], controlIndices: number[]): void {
  for (let s = 0; s + 1 < controlIndices.length; s++) {
    const a = controlIndices[s]
    const b = controlIndices[s + 1]
    const n = b - a
    const arc: number[] = [0]
    for (let k = a; k < b; k++) {
      arc.push(arc[arc.length - 1] + Math.hypot(pts[k + 1][0] - pts[k][0], pts[k + 1][1] - pts[k][1]))
    }
    const total = arc[n]
    if (!(total > 0)) continue

    const moves: [number, number][] = []
    for (let k = a + 1; k < b; k++) {
      const tx = pts[k + 1][0] - pts[k - 1][0]
      const ty = pts[k + 1][1] - pts[k - 1][1]
      const tl = Math.hypot(tx, ty)
      if (tl < 1e-12) {
        moves.push([0, 0])
        continue
      }
      const ux = tx / tl
      const uy = ty / tl
      const i = k - a
      const local = Math.min(arc[i] - arc[i - 1], arc[i + 1] - arc[i])
      const shift = Math.max(-0.5 * local, Math.min(0.5 * local, (i * total) / n - arc[i]))
      moves.push([ux * shift, uy * shift])
    }
    for (let k = a + 1; k < b; k++) {
      const [mx, my] = moves[k - a - 1]
      pts[k][0] += mx
      pts[k][1] += my
      const ml = Math.hypot(mx, my)
      const tx = pts[Math.min(k + 1, pts.length - 1)][0] - pts[k - 1][0]
      const ty = pts[Math.min(k + 1, pts.length - 1)][1] - pts[k - 1][1]
      const tl = Math.hypot(tx, ty)
      if (tl > 1e-12 && ml >= 0 && vel[k]) {
        const along = (vel[k][0] * tx + vel[k][1] * ty) / tl
        vel[k][0] -= (along * tx) / tl
        vel[k][1] -= (along * ty) / tl
      }
    }
  }
}
