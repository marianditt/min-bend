import { describe, expect, it } from 'vitest'
import type { Setup } from '../solver/types'
import { setFixPosFree, setResolution, toggleCurveHidden } from './setupEdits'

const base = (): Setup => ({
  resolution: 1,
  curves: [
    {
      fixPoints: [
        { id: 'p1', pos: [0, 0], orientation: null },
        { id: 'p2', pos: [1, 0], orientation: null },
      ],
      spans: [[]],
    },
  ],
})

describe('toggleCurveHidden', () => {
  it('flips the hidden flag without mutating the input', () => {
    const setup = base()
    const shown = toggleCurveHidden(setup, 0)
    expect(shown.curves[0].hidden).toBe(true)
    expect(setup.curves[0].hidden).toBeUndefined()
    expect(toggleCurveHidden(shown, 0).curves[0].hidden).toBe(false)
  })

  it('is a no-op for an out-of-range index', () => {
    const setup = base()
    expect(toggleCurveHidden(setup, 3)).toBe(setup)
  })
})

describe('setFixPosFree', () => {
  it('toggles the free-position flag without mutating the input', () => {
    const setup = base()
    const free = setFixPosFree(setup, 0, 1, true)
    expect(free.curves[0].fixPoints[1].posFree).toBe(true)
    expect(setup.curves[0].fixPoints[1].posFree).toBeUndefined()
    expect(setFixPosFree(free, 0, 1, false).curves[0].fixPoints[1].posFree).toBeUndefined()
  })
})

describe('setResolution', () => {
  it('updates the global resolution immutably', () => {
    const setup = base()
    expect(setResolution(setup, 0.5).resolution).toBe(0.5)
    expect(setup.resolution).toBe(1)
    expect(setResolution(setup, 1)).toBe(setup)
  })
})

import { addConstraint, addFixPoint, followPoint, removeFixPoint } from './setupEdits'
import { simplifyStroke } from './sketch'
import { locate } from '../solver/constraints'

describe('stable point ids', () => {
  const three = (): Setup => {
    const s = addFixPoint(base(), 0)
    return s
  }

  it('keeps constraints attached to their points when an earlier point is deleted', () => {
    let s = three()
    const [a, , c] = s.curves[0].fixPoints.map((p) => p.id)
    s = addConstraint(s, { kind: 'orientation', source: a, target: c, delta: 10 })
    s = removeFixPoint(s, 0, 1)
    expect(s.constraints).toEqual([{ kind: 'orientation', source: a, target: c, delta: 10 }])
    expect(locate(s, c)).toEqual({ curve: 0, point: 1 })
  })

  it('deletes constraints whose point is deleted', () => {
    let s = three()
    const [a, b, c] = s.curves[0].fixPoints.map((p) => p.id)
    s = addConstraint(s, { kind: 'position', source: a, target: c })
    s = addConstraint(s, { kind: 'orientation', source: b, target: a })
    s = removeFixPoint(s, 0, 2)
    expect(s.constraints).toEqual([{ kind: 'orientation', source: b, target: a }])
    expect(new Set(s.curves[0].fixPoints.map((p) => p.id)).size).toBe(2)
  })

  it('never reuses the id of a deleted point', () => {
    let s = removeFixPoint(three(), 0, 2)
    s = addFixPoint(s, 0)
    expect(new Set(s.curves[0].fixPoints.map((p) => p.id)).size).toBe(3)
  })

  it('followPoint links to a neighbour', () => {
    const s = followPoint(three(), 'orientation', 'p2')
    expect(s.constraints?.[0]).toMatchObject({ kind: 'orientation', target: 'p2', source: 'p1' })
  })
})

describe('simplifyStroke', () => {
  it('reduces a straight noisy stroke to its ends', () => {
    const stroke: [number, number][] = Array.from({ length: 20 }, (_, i) => [i, (i % 2) * 0.1])
    expect(simplifyStroke(stroke, 1)).toHaveLength(2)
  })
  it('keeps a corner', () => {
    expect(simplifyStroke([[0, 0], [5, 0], [10, 0], [10, 5], [10, 10]], 0.5)).toEqual([[0, 0], [10, 0], [10, 10]])
  })
})
