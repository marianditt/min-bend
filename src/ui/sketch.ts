import type { Vec2 } from '../solver/types'

function distanceToSegment(p: Vec2, a: Vec2, b: Vec2): number {
  const dx = b[0] - a[0]
  const dy = b[1] - a[1]
  const len2 = dx * dx + dy * dy
  const t = len2 === 0 ? 0 : Math.min(Math.max(((p[0] - a[0]) * dx + (p[1] - a[1]) * dy) / len2, 0), 1)
  return Math.hypot(p[0] - (a[0] + t * dx), p[1] - (a[1] + t * dy))
}

/** Ramer–Douglas–Peucker: the fewest points of `stroke` that stay within `tolerance` of it. Keeps both ends. */
export function simplifyStroke(stroke: Vec2[], tolerance: number): Vec2[] {
  if (stroke.length <= 2) return stroke.map((p) => [p[0], p[1]])
  const keep = new Array<boolean>(stroke.length).fill(false)
  keep[0] = keep[stroke.length - 1] = true
  const pending: [number, number][] = [[0, stroke.length - 1]]
  while (pending.length > 0) {
    const [from, to] = pending.pop()!
    let worst = -1
    let worstDist = tolerance
    for (let i = from + 1; i < to; i++) {
      const d = distanceToSegment(stroke[i], stroke[from], stroke[to])
      if (d > worstDist) {
        worst = i
        worstDist = d
      }
    }
    if (worst >= 0) {
      keep[worst] = true
      pending.push([from, worst], [worst, to])
    }
  }
  return stroke.filter((_, i) => keep[i]).map((p) => [p[0], p[1]])
}
