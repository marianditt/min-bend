import { describe, expect, it } from 'vitest'
import type { Setup } from '../solver/types'
import { addConstraint, addFixPoint, followPoint, removeFixPoint, setFixPosFree, setResolution, toggleCurveHidden } from './setupEdits'
import { locate } from '../solver/constraints'

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


/** Curve A (p1, p2, p3) above curve B (p4, p5, p6). */
const twoCurves = (): Setup => {
  const pts = (ids: string[], y: number) => ids.map((id, i) => ({ id, pos: [i, y] as [number, number], orientation: null }))
  return {
    resolution: 1,
    curves: [
      { fixPoints: pts(['p1', 'p2', 'p3'], 0), spans: [[], []] },
      { fixPoints: pts(['p4', 'p5', 'p6'], -2), spans: [[], []] },
    ],
  }
}

describe('stable point ids', () => {
  it('keeps constraints attached to their points when an earlier point is deleted', () => {
    let s = addConstraint(twoCurves(), { kind: 'orientation', source: 'p1', target: 'p6', delta: 10 })
    s = removeFixPoint(s, 1, 1)
    expect(s.constraints).toEqual([{ kind: 'orientation', source: 'p1', target: 'p6', delta: 10 }])
    expect(locate(s, 'p6')).toEqual({ curve: 1, point: 1 })
  })

  it('deletes constraints whose point is deleted', () => {
    let s = addConstraint(twoCurves(), { kind: 'position', source: 'p1', target: 'p6' })
    s = addConstraint(s, { kind: 'orientation', source: 'p2', target: 'p4' })
    s = removeFixPoint(s, 1, 2)
    expect(s.constraints).toEqual([{ kind: 'orientation', source: 'p2', target: 'p4' }])
  })

  it('never reuses the id of a deleted point', () => {
    let s = removeFixPoint(addFixPoint(base(), 0), 0, 2)
    s = addFixPoint(s, 0)
    expect(new Set(s.curves[0].fixPoints.map((p) => p.id)).size).toBe(3)
  })
})

describe('follow rules', () => {
  it('refuses a source on the same curve', () => {
    const s = twoCurves()
    expect(addConstraint(s, { kind: 'position', source: 'p1', target: 'p2' })).toBe(s)
  })

  it('refuses a second, different source for the same point', () => {
    const s = addConstraint(twoCurves(), { kind: 'position', source: 'p1', target: 'p4' })
    expect(addConstraint(s, { kind: 'orientation', source: 'p2', target: 'p4' })).toBe(s)
    expect(addConstraint(s, { kind: 'orientation', source: 'p1', target: 'p4' })).not.toBe(s)
  })

  it('direction follows the point the position follows', () => {
    const s = addConstraint(twoCurves(), { kind: 'position', source: 'p2', target: 'p5' })
    const next = followPoint(s, 'orientation', 'p5')
    expect(next.constraints).toContainEqual({ kind: 'orientation', source: 'p2', target: 'p5' })
  })

  it('continues along the same other curve as the previous point', () => {
    const s = addConstraint(twoCurves(), { kind: 'position', source: 'p1', target: 'p4' })
    const next = followPoint(s, 'position', 'p5')
    expect(next.constraints).toContainEqual({ kind: 'position', source: 'p2', target: 'p5' })
  })

  it('picks a point of another curve when nothing else hints', () => {
    const next = followPoint(twoCurves(), 'orientation', 'p5')
    expect(locate(next, next.constraints![0].source)?.curve).toBe(0)
  })

  it('does nothing with a single curve', () => {
    const s = base()
    expect(followPoint(s, 'position', 'p2')).toBe(s)
  })
})
