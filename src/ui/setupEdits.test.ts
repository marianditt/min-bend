import { describe, expect, it } from 'vitest'
import type { Curve, Setup, Vec2 } from '../solver/types'
import { appendBakedCurve, curveFromPolyline, toggleCurveHidden } from './setupEdits'

function curve(n: number, orientations: (Vec2 | null)[] = []): Curve {
  return {
    n,
    fixPoints: orientations.map((orientation, i) => ({ pos: [i * 3, 0] as Vec2, orientation })),
    spans: Array.from({ length: Math.max(orientations.length - 1, 0) }, () => []),
  }
}

describe('toggleCurveHidden', () => {
  it('flips the hidden flag without mutating the input', () => {
    const setup: Setup = { curves: [{ n: 1, fixPoints: [{ pos: [0, 0], orientation: null }, { pos: [1, 0], orientation: null }], spans: [[]] }] }
    const shown = toggleCurveHidden(setup, 0)
    expect(shown.curves[0].hidden).toBe(true)
    expect(setup.curves[0].hidden).toBeUndefined()
    expect(toggleCurveHidden(shown, 0).curves[0].hidden).toBe(false)
  })

  it('is a no-op for an out-of-range index', () => {
    const setup: Setup = { curves: [] }
    expect(toggleCurveHidden(setup, 3)).toBe(setup)
  })
})

describe('curveFromPolyline', () => {
  it('bakes fix points and free interior slots, preserving structure', () => {
    const source: Curve = { ...curve(3, [null, null]), targetLength: 9 }
    const poly: Vec2[] = [
      [10, 1],
      [11, 2],
      [12, 3],
      [13, 4],
      [20, 5],
    ]
    const baked = curveFromPolyline(source, poly)
    expect(baked.n).toBe(3)
    expect(baked.fixPoints).toEqual([
      { pos: [10, 1], orientation: null },
      { pos: [20, 5], orientation: null },
    ])
    expect(baked.spans).toEqual([[[11, 2], [12, 3], [13, 4]]])
    expect(baked.targetLength).toBe(9)
    expect(baked.hidden).toBeUndefined()
  })

  it('omits slots bound by an oriented fix point', () => {
    const source = curve(3, [[1, 0], null])
    const poly: Vec2[] = [
      [0, 0],
      [1, 1],
      [2, 2],
      [3, 3],
      [4, 4],
    ]
    const baked = curveFromPolyline(source, poly)
    expect(baked.spans).toEqual([[[2, 2], [3, 3]]])
  })

  it('uses the source position when the polyline is too short', () => {
    const source = curve(3, [null, null])
    const baked = curveFromPolyline(source, [[10, 1], [11, 2]])
    expect(baked.fixPoints[0].pos).toEqual([10, 1])
    expect(baked.fixPoints[1].pos).toEqual([3, 0])
  })

  it('offsets free slots correctly across multiple spans', () => {
    const source = curve(2, [null, null, null])
    const poly: Vec2[] = [
      [0, 0],
      [1, 0],
      [2, 0],
      [3, 0],
      [4, 0],
      [5, 0],
      [6, 0],
    ]
    const baked = curveFromPolyline(source, poly)
    expect(baked.spans).toEqual([[[1, 0], [2, 0]], [[4, 0], [5, 0]]])
  })
})

describe('appendBakedCurve', () => {
  it('appends a baked curve without mutating the input setup', () => {
    const setup: Setup = { curves: [curve(3, [null, null])] }
    const poly: Vec2[] = [
      [10, 1],
      [11, 2],
      [12, 3],
      [13, 4],
      [20, 5],
    ]
    const appended = appendBakedCurve(setup, poly, setup.curves[0])
    expect(appended.curves).toHaveLength(2)
    expect(appended.curves[1].n).toBe(3)
    expect(setup.curves).toHaveLength(1)
  })
})
