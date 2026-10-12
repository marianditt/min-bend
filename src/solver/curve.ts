import type { Curve } from './types'

/** Interior slot indices (1..n) a user may place, excluding slots bound by oriented fix points. */
export function freeSlotsFor(n: number, hasStart: boolean, hasEnd: boolean): number[] {
  const slots: number[] = []
  for (let k = 1; k <= n; k++) {
    if (hasStart && k === 1) continue
    if (hasEnd && k === n) continue
    slots.push(k)
  }
  return slots
}

/** Editable interior slots of span `si` (not bound by an oriented fix point). */
export function freeSlotIndices(curve: Curve, si: number): number[] {
  const n = Math.max(0, Math.floor(curve.n))
  const hasStart = curve.fixPoints[si]?.orientation != null
  const hasEnd = curve.fixPoints[si + 1]?.orientation != null
  return freeSlotsFor(n, hasStart, hasEnd)
}

/** How many free interior points a span can still accept. */
export function freeSlotCount(curve: Curve, si: number): number {
  return freeSlotIndices(curve, si).length
}

/** Global index of each fix point within a curve's reassembled polyline (stride `n + 1`). */
export function fixIndices(curve: Curve): number[] {
  const n = Math.max(0, Math.floor(curve.n))
  const indices: number[] = []
  for (let i = 0; i < curve.fixPoints.length; i += 1) indices.push(i * (n + 1))
  return indices
}
