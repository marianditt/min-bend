import { describe, expect, it } from 'vitest'
import { DEFAULT_SETUP } from './defaults'
import { addFixPoint, isCurveClosed, setCurveClosed } from './setupEdits'
import { addNgon, ngonProblem, ngonVertices } from './presets'

describe('n-gon preset', () => {
  it('places vertices on the circle around the origin', () => {
    const v = ngonVertices({ n: 4, origin: [1, 2], radius: 3 })
    expect(v[0]).toEqual([4, 2])
    expect(v[1][0]).toBeCloseTo(1)
    expect(v[1][1]).toBeCloseTo(5)
  })

  it('adds a closed curve', () => {
    const s = addNgon(DEFAULT_SETUP, { n: 5, origin: [0, 0], radius: 1 })
    const c = s.curves[1]
    expect(c.fixPoints).toHaveLength(6)
    expect(isCurveClosed(s, 1)).toBe(true)
  })

  it('toggles closure and keeps the closing point last when adding points', () => {
    let s = setCurveClosed(DEFAULT_SETUP, 0, true)
    expect(isCurveClosed(s, 0)).toBe(true)
    s = addFixPoint(s, 0)
    const ids = s.curves[0].fixPoints.map((p) => p.id)
    expect(ids).toEqual(['p1', 'p3', 'p2'])
    expect(isCurveClosed(s, 0)).toBe(true)
    expect(isCurveClosed(setCurveClosed(s, 0, false), 0)).toBe(false)
  })

  it('rejects bad parameters', () => {
    expect(ngonProblem({ n: 2, origin: [0, 0], radius: 1 })).not.toBeNull()
    expect(addNgon(DEFAULT_SETUP, { n: 3, origin: [0, 0], radius: 0 })).toBe(DEFAULT_SETUP)
  })
})
