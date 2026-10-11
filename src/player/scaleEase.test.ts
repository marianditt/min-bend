import { describe, expect, it } from 'vitest'
import {
  boundsForScale,
  fitScale,
  nextDisplayedScale,
  type Bounds,
  type EasePhase,
} from './scaleEase'

const zoomIn = {
  previous: 1,
  target: 2,
  phase: null,
  frameIndex: 5,
  totalFrames: 101,
  easingEnabled: true,
}

describe('nextDisplayedScale', () => {
  it('shows the true target when easing is disabled, even mid-ease and on zoom-in', () => {
    const phase: EasePhase = { startScale: 1, startFrame: 5 }
    expect(nextDisplayedScale({ ...zoomIn, phase, frameIndex: 10, easingEnabled: false })).toEqual({
      scale: 2,
      phase: null,
    })
  })

  it('snaps to target on zoom-out and cancels any in-flight ease', () => {
    const phase: EasePhase = { startScale: 1.5, startFrame: 5 }
    expect(
      nextDisplayedScale({ previous: 1.5, target: 1, phase, frameIndex: 10, totalFrames: 101, easingEnabled: true }),
    ).toEqual({ scale: 1, phase: null })
  })

  it('starts slow on the first zoom-in frame without moving yet', () => {
    const result = nextDisplayedScale(zoomIn)
    expect(result.scale).toBe(1)
    expect(result.phase).toEqual({ startScale: 1, startFrame: 5 })
    expect(result.phase?.startScale).toBe(1)
    expect(result.phase?.startFrame).toBe(5)
  })

  it('eases in quadratically and stays closer to the start than a linear ease', () => {
    const phase: EasePhase = { startScale: 1, startFrame: 5 }
    const result = nextDisplayedScale({ ...zoomIn, phase, frameIndex: 10 })
    const t = 5 / 95
    const alpha = t * t
    expect(result.scale).toBeCloseTo(1 + alpha, 12)
    expect(result.scale).toBeGreaterThan(1)
    expect(result.scale).toBeLessThan(2)
    expect(alpha).toBeLessThan(t)
    expect(result.scale).toBeLessThan(1 + t)
    expect(result.phase).toBe(phase)
  })

  it('catches up to the target exactly on the final frame', () => {
    const phase: EasePhase = { startScale: 1, startFrame: 5 }
    const result = nextDisplayedScale({ ...zoomIn, phase, frameIndex: 100 })
    expect(result.scale).toBe(2)
  })
})

describe('fitScale', () => {
  it('fits 10x20 world units in an 800x600 canvas', () => {
    const bounds: Bounds = { minX: 0, minY: 0, maxX: 10, maxY: 20 }
    // pad = max(22, min(800,600)*0.09) = 54 -> availW 692, availH 492.
    expect(fitScale(bounds, 800, 600)).toBeCloseTo(Math.min(692 / 10, 492 / 20), 10)
  })
})

describe('boundsForScale', () => {
  it('returns bounds whose fit equals the eased scale and keeps the center', () => {
    const bounds: Bounds = { minX: -3, minY: 4, maxX: 7, maxY: 24 }
    const f = fitScale(bounds, 800, 600)
    const eased = 0.7 * f
    const scaled = boundsForScale(bounds, f, eased)
    expect(fitScale(scaled, 800, 600)).toBeCloseTo(eased, 6)
    expect((scaled.minX + scaled.maxX) / 2).toBeCloseTo((bounds.minX + bounds.maxX) / 2, 12)
    expect((scaled.minY + scaled.maxY) / 2).toBeCloseTo((bounds.minY + bounds.maxY) / 2, 12)
  })
})
