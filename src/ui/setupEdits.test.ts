import { describe, expect, it } from 'vitest'
import type { Setup } from '../solver/types'
import { setFixPosFree, setResolution, toggleCurveHidden } from './setupEdits'

const base = (): Setup => ({
  resolution: 1,
  curves: [
    {
      fixPoints: [
        { pos: [0, 0], orientation: null },
        { pos: [1, 0], orientation: null },
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
