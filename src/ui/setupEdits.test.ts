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
  const fourFixSource = (): Curve => curve(2, [[1, 0], null, [0, 1], null])
  const tenPointPoly = (): Vec2[] => Array.from({ length: 10 }, (_, i): Vec2 => [i, i * 0.5])

  it('turns every polyline point into a fix point with n = 0', () => {
    const baked = curveFromPolyline(fourFixSource(), tenPointPoly())
    expect(baked.n).toBe(0)
    expect(baked.fixPoints).toHaveLength(10)
    expect(baked.fixPoints.map((fp) => fp.pos)).toEqual(tenPointPoly())
    expect(baked.spans).toHaveLength(9)
    expect(baked.spans.every((span) => span.length === 0)).toBe(true)
    expect(baked.targetLength).toBeUndefined()
  })

  it('copies source fix-point tangents and leaves derived points unoriented', () => {
    const baked = curveFromPolyline(fourFixSource(), tenPointPoly())
    expect(baked.fixPoints[0].orientation).toEqual([1, 0])
    expect(baked.fixPoints[6].orientation).toEqual([0, 1])
    expect(baked.fixPoints[3].orientation).toBeNull()
    expect(baked.fixPoints[9].orientation).toBeNull()
    for (const i of [1, 2, 4, 5, 7, 8]) {
      expect(baked.fixPoints[i].orientation).toBeNull()
    }
  })

  it('keeps endpoint tangents for a single-span source', () => {
    const source = curve(6, [[0, 1], [0, 1]])
    const poly = Array.from({ length: 8 }, (_, i): Vec2 => [i, 0])
    const baked = curveFromPolyline(source, poly)
    expect(baked.n).toBe(0)
    expect(baked.fixPoints).toHaveLength(8)
    expect(baked.fixPoints[0]).toEqual({ pos: [0, 0], orientation: [0, 1] })
    expect(baked.fixPoints[7]).toEqual({ pos: [7, 0], orientation: [0, 1] })
    expect(baked.fixPoints[3].orientation).toBeNull()
  })
})

describe('appendBakedCurve', () => {
  it('appends a fully-fixed baked curve without mutating the input setup', () => {
    const setup: Setup = { curves: [curve(2, [[1, 0], null, [0, 1], null])] }
    const poly = Array.from({ length: 10 }, (_, i): Vec2 => [i, i * 0.5])
    const appended = appendBakedCurve(setup, poly, setup.curves[0])
    expect(appended.curves).toHaveLength(2)
    expect(appended.curves[1].n).toBe(0)
    expect(appended.curves[1].fixPoints).toHaveLength(10)
    expect(appended.curves[0].n).toBe(2)
    expect(setup.curves).toHaveLength(1)
  })
})
